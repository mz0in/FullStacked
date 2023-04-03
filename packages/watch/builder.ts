import {dirname, resolve} from "path";
import fs from "fs";
import {build} from "esbuild";
import {
    analyzeRawImportStatement, convertImportDefinitionToAsyncImport,
    mergeImportsDefinitions, replaceLines,
    tokenizeImports
} from "./fileParser";
import randStr from "fullstacked/utils/randStr";
import {possibleJSExtensions} from "./utils";

type BuilderOptions = {
    entrypoint: ModulePath,
    outdir?: string,
    recurse?: boolean,
    moduleResolverWrapperFunction?: string,
    assetDir?: string,
    publicPath?: string,
    externalModules?: {
        convert?: boolean,
        bundle?: boolean,
        bundleOutName?: string
    }
}

const defaultOptions: Omit<BuilderOptions, 'entrypoint'> = {
    outdir: "dist",
    assetDir: "",
    publicPath: "/",
    externalModules: {
        bundleOutName: "externals.js"
    }
}

export default async function(options: BuilderOptions) {
    options = {
        ...defaultOptions,
        ...options
    }
    options.externalModules = {
        ...defaultOptions.externalModules,
        ...(options.externalModules ?? {})
    }

    const { modulesFlatTree, externalModules, cssFiles, assetFiles } = await builder(options);

    const entrypointDir = dirname(options.entrypoint);
    const mainOutDir = resolve(options.outdir, entrypointDir);

    if (options.externalModules.bundle) {
        await bundleExternalModules(externalModules, mainOutDir, options.externalModules.bundleOutName);
    }

    if (cssFiles.length) {
        await bundleCSSFiles(cssFiles, mainOutDir, "index.css")
    }

    if (assetFiles.length) {
        const assetDirectory = resolve(mainOutDir, options.assetDir);

        if (!fs.existsSync(assetDirectory))
            fs.mkdirSync(assetDirectory, { recursive: true });

        assetFiles.forEach(asset => {
            modulesFlatTree[asset.assetPath].out = resolve(assetDirectory, asset.uniqName);
            fs.copyFileSync(asset.assetPath, resolve(assetDirectory, asset.uniqName));
        })
    }

    return { modulesFlatTree, cssFiles, assetFiles }
}

type ModulePath = string;
type ModulesFlatTree = {
    [modulePath: ModulePath]: {
        assetName?: string,
        out?: string,
        imports: Set<ModulePath>,
        parents: ModulePath[]
    }
}

type AssetFile = {
    assetPath: string,
    uniqName: string
}

async function builder(options: Omit<BuilderOptions, 'entrypoints'> & {entrypoint: string},
                       modulesFlatTree: ModulesFlatTree = {},
                       externalModules: string[] = [],
                       cssFiles: string[] = [],
                       assetFiles: AssetFile[] = []) {

    const entrypoint = options.entrypoint + getModulePathExtension(options.entrypoint);

    const currentDir = dirname(entrypoint);

    if (!modulesFlatTree[entrypoint]) {
        modulesFlatTree[entrypoint] = {
            imports: new Set(),
            parents: []
        }
    }

    await build({
        entryPoints: [entrypoint],
        outdir: resolve(process.cwd(), options.outdir, currentDir),
        format: "esm",
        allowOverwrite: true,
        plugins: [{
            name: "recursive-builder",
            setup(build) {

                build.onLoad({ filter: /.*/ }, async ({ path }) => {
                    const contents = fs.readFileSync(path).toString();

                    const importStatements = tokenizeImports(contents);

                    const statements = importStatements?.statements ?? [];
                    const lines = importStatements?.lines ?? [undefined, undefined];

                    const asyncImports = [];
                    let importsDefinitions = statements
                        .map(statement => analyzeRawImportStatement(statement))
                        .filter(statement => !statement.type);

                    if (!options.externalModules.convert) {
                        importsDefinitions = importsDefinitions.filter((importDef, index) => {
                            if (importDef.module.startsWith(".")) return true;
                            asyncImports.push(statements[index].join(" ") + ";");
                            return false;
                        })
                    }

                    const mergedDefinition = mergeImportsDefinitions(importsDefinitions);
                    const entries = Array.from(mergedDefinition.entries());

                    if (!modulesFlatTree[entrypoint].imports) {
                        modulesFlatTree[entrypoint].imports = new Set();
                    }

                    const buildPromises = [];
                    for (let i = 0; i < entries.length; i++) {
                        let [moduleName, importDefinition] = entries[i];

                        // node_modules
                        if (!moduleName.startsWith(".")) {
                            if (moduleName.endsWith(".css") && fs.existsSync(`./node_modules/${moduleName}`)) {
                                cssFiles.push(`./node_modules/${moduleName}`);
                                continue;
                            }

                            modulesFlatTree[entrypoint].imports.add(moduleName);

                            if (options.externalModules.convert) {

                                if (!externalModules.includes(moduleName))
                                    externalModules.push(moduleName)

                                const indexOfExternalModule = externalModules.indexOf(moduleName);

                                const bundleName = options.publicPath + options.externalModules.bundleOutName;
                                asyncImports.push(...convertImportDefinitionToAsyncImport(bundleName, importDefinition, "externalModule" + indexOfExternalModule, undefined, true));
                            }

                            continue;
                        }

                        let moduleRelativePathToProject = resolve(currentDir, moduleName).replace(process.cwd(), ".");
                        const extension = getModulePathExtension(moduleRelativePathToProject);

                        moduleRelativePathToProject += extension;
                        modulesFlatTree[entrypoint].imports.add(moduleRelativePathToProject);

                        moduleName += extension;

                        // CSS or asset file
                        if (![".js", ".jsx", ".mjs", ".ts", ".tsx"].find(ext => moduleName.endsWith(ext))) {

                            if (!modulesFlatTree[moduleRelativePathToProject]) {
                                modulesFlatTree[moduleRelativePathToProject] = {
                                    imports: new Set(),
                                    parents: []
                                }
                            }

                            modulesFlatTree[moduleRelativePathToProject].parents.push(entrypoint);

                            if (moduleName.endsWith(".css")) {
                                cssFiles.push(moduleRelativePathToProject);
                            }
                            else {
                                const pathSplitAtSlash = moduleRelativePathToProject.split("/");
                                const assetFileName = pathSplitAtSlash.pop();

                                const assetFileNameSplitAtDots = assetFileName.split(".");
                                const extension = assetFileNameSplitAtDots.pop();

                                const uniqName = `${assetFileNameSplitAtDots.join(".")}-${randStr()}.${extension}`

                                assetFiles.push({
                                    assetPath: moduleRelativePathToProject,
                                    uniqName
                                });

                                modulesFlatTree[moduleRelativePathToProject].assetName = uniqName;

                                pathSplitAtSlash.push(uniqName);

                                asyncImports.push(...convertImportDefinitionToAsyncImport(moduleRelativePathToProject, importDefinition, null, options.moduleResolverWrapperFunction));
                            }

                            continue;
                        }


                        if (options.recurse) {
                            buildPromises.push(builder({
                                ...options,
                                entrypoint: moduleRelativePathToProject
                            }, modulesFlatTree, externalModules, cssFiles, assetFiles));
                        }

                        if (!modulesFlatTree[moduleRelativePathToProject]) {
                            modulesFlatTree[moduleRelativePathToProject] = {
                                imports: new Set(),
                                parents: []
                            }
                        }

                        modulesFlatTree[moduleRelativePathToProject].parents.push(entrypoint);

                        asyncImports.push(...convertImportDefinitionToAsyncImport(moduleRelativePathToProject, importDefinition, "module" + i, options.moduleResolverWrapperFunction));
                    }

                    await Promise.all(buildPromises);

                    return {
                        contents: replaceLines(lines[0], lines[1], contents, asyncImports.join(" ")),
                        loader: path.endsWith(".ts")
                            ? "ts"
                            : path.endsWith(".jsx") || path.endsWith(".tsx")
                                ? "jsx"
                                : "js"
                    }
                });
            }
        }]
    });

    return { modulesFlatTree, externalModules, cssFiles, assetFiles }
}

export function getModulePathExtension(modulePath: ModulePath) {
    return possibleJSExtensions.find(ext => fs.existsSync(modulePath + ext) && fs.statSync(modulePath + ext).isFile());
}

export async function bundleExternalModules(modulesList, outdir, bundleName) {
    const intermediateFile = `./${randStr()}.js`;
    fs.writeFileSync(intermediateFile, modulesList.map((moduleName, i) => `export * as externalModule${i} from "${moduleName}";`).join('\n'));
    await build({
        entryPoints: [intermediateFile],
        format: "esm",
        allowOverwrite: true,
        bundle: true,
        outfile: resolve(process.cwd(), outdir, bundleName),
        plugins: [{
            name: "delete-temp-file",
            setup(build) {
                build.onEnd(() => fs.rmSync(intermediateFile))
            }
        }]
    });
}

export async function bundleCSSFiles(modulesList, outdir, bundleName) {
    const intermediateJSFile = `./${randStr()}.js`;
    const intermediateOutJSFile = resolve(process.cwd(), outdir, intermediateJSFile);
    const intermediateOutCSSFile = intermediateOutJSFile.slice(0, -3) + ".css";
    const outCssFile = resolve(process.cwd(), outdir, bundleName);
    fs.writeFileSync(intermediateJSFile, modulesList.map((moduleName) => `import "${moduleName}";`).join('\n'));
    await build({
        entryPoints: [intermediateJSFile],
        format: "esm",
        allowOverwrite: true,
        bundle: true,
        outfile: intermediateOutJSFile,
        plugins: [{
            name: "copy-files",
            setup(build) {
                build.onEnd(() => {
                    fs.renameSync(intermediateOutCSSFile, outCssFile);
                    fs.rmSync(intermediateJSFile);
                    fs.rmSync(intermediateOutJSFile);
                })
            }
        }]
    });
}
