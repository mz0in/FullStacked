import {dirname, resolve} from "path"
import esbuild, {BuildOptions, buildSync, Format, Loader, Platform} from "esbuild";
import fs from "fs";
import {
    cleanOutDir, copyRecursiveSync, execScript,
    getBuiltDockerCompose, getExternalModules
} from "../utils/utils";
import yaml from "js-yaml";
import glob from "glob";
import {parse, parseFragment, Parser, serialize, html} from "parse5";
import {fileURLToPath} from "url";
import {FullStackedConfig} from "../index";
import randStr from "../utils/randStr";
import {config as dotenvConfig} from "dotenv"

const __dirname = dirname(fileURLToPath(import.meta.url));

// load .env located at root of src
function loadEnvVars(srcDir: string){
    const path = resolve(srcDir, ".env");

    if(!fs.existsSync(path)) return;

    dotenvConfig({path});
}

// get all env variables in the form of an object
function getProcessEnv(config: FullStackedConfig){
    let processEnv = {};
    Object.keys(process.env).forEach(envKey => {
        // keys with parenthesis causes problems
        if(envKey.includes("(") || envKey.includes(")") || envKey.includes("-") || envKey.includes("%"))
            return;

        processEnv['process.env.' + envKey] = "'" + escape(process.env[envKey].trim()) + "'";
    });

    processEnv['process.env.VERSION'] = JSON.stringify(config.version)

    return processEnv;
}

// bundles the server
async function buildServer(config: FullStackedConfig, watcher){
    const fullstackedServerFile = resolve(__dirname, "..", "server.js");

    const fullstackedServerFileRegex =  new RegExp(fullstackedServerFile
        // windows file path...
        .replace(/\\/g, "\\\\"));

    const options: BuildOptions = {
        entryPoints: [ fullstackedServerFile ],
        outfile: resolve(config.out, "index.mjs"),
        platform: "node" as Platform,
        bundle: true,
        format: "esm" as Format,

        external: getExternalModules(config.src),

        define: getProcessEnv(config),

        // source: https://github.com/evanw/esbuild/issues/1921#issuecomment-1166291751
        banner: {js: "import { createRequire } from 'module';const require = createRequire(import.meta.url);"},

        plugins: [{
            name: 'fullstacked-pre-post-scripts',
            setup(build){
                build.onStart(async () => {
                    // prebuild script, false for isWebApp
                    await execScript(resolve(config.src, "prebuild.ts"), config, false);
                });
                build.onEnd(async () => {
                    // postbuild script, false for isWebApp
                    await execScript(resolve(config.src, "postbuild.ts"), config, false);
                });
            }
        }, {
            name: 'fullstacked-bundled-server',
            setup(build) {
                build.onLoad({ filter: fullstackedServerFileRegex }, async () => {
                    // load all entry points from server dir
                    const serverFiles = glob.sync(resolve(config.src, "server", "**", "*.server.ts"));

                    // well keep server/index.ts as an entrypoint also
                    const indexServerFile = resolve(config.src, "server", "index.ts");
                    if(fs.existsSync(indexServerFile))
                        serverFiles.unshift(indexServerFile);

                    const contents =
                        fs.readFileSync(fullstackedServerFile) + "\n" +
                        serverFiles.map(file => `import("${file.replace(/\\/g, "\\\\")}");`).join("\n")

                    return {
                        contents,
                        loader: 'ts',
                    }
                })
            },
        }],

        watch: watcher ? {
            onRebuild: async function(error, result){
                if(error) return;
                watcher();
            }
        } : false
    }

    const result = await  esbuild.build(options);

    if(result.errors.length > 0)
        return;

    const dockerCompose = getBuiltDockerCompose(config.src, config.production);

    const nativeFilePath = resolve(config.src, "server", "native.json")
    if(fs.existsSync(nativeFilePath)){
        fs.cpSync(nativeFilePath, resolve(config.out, "native.json"));
        fs.cpSync(resolve(__dirname, "..", "server", "installNative.js"), resolve(config.out, "installNative.mjs"));
        dockerCompose.services.node.command = [
            "/bin/sh",
            "-c",
            `node installNative.mjs ${!config.production ? "--development" : ""} && node index.mjs ${!config.production ? "--development" : ""}`
        ]
    }

    if(watcher){
        fs.copyFileSync(resolve(__dirname, "..", "server", "watcher.js"), resolve(config.out, "watcher.js"))
    }

    // output docker-compose result to dist directory
    fs.writeFileSync(resolve(config.dist, "docker-compose.yml"), yaml.dump(dockerCompose));

    if(!config.silent)
        console.log('\x1b[32m%s\x1b[0m', "Server Built");
}

// bundles the web app
async function buildWebApp(config, watcher){
    const entrypoint = resolve(config.src, "webapp", "index.ts");

    if(!fs.existsSync(entrypoint)){
        fs.mkdirSync(config.public, {recursive: true});
        return fs.writeFileSync(resolve(config.public, "index.html"), "Nothing to see here...");
    }

    // pre/post build scripts
    const plugins = [{
        name: 'fullstacked-pre-post-scripts',
        setup(build){
            build.onStart(async () => {
                // make sure to clear dist/public dir
                if(fs.existsSync(config.public)) fs.rmSync(config.public, {force: true, recursive: true});

                // prebuild script, true for isWebApp
                await execScript(resolve(config.src, "prebuild.ts"), config, true);
            });
            build.onEnd(async () => {
                webAppPostBuild(config, watcher);
                // postbuild script, true for isWebApp
                await execScript(resolve(config.src, "postbuild.ts"), config, true);
            });
        }
    }];

    // extra files and dir to watch
    if(watcher){
        plugins.push({
            name: 'watch-extra-files',
            setup(build) {

                const extraFiles = config.watchFile
                    ? Array.isArray(config.watchFile)
                        ? config.watchFile.map(file => resolve(config.src, file))
                        : [resolve(config.src, config.watchFile)]
                    : [];

                const extraDirs = config.watchDir
                    ? Array.isArray(config.watchDir)
                        ? config.watchDir.map(dir => resolve(config.src, dir))
                        : [resolve(config.src, config.watchDir)]
                    : [];

                const filesInDir = extraDirs.map(dir => glob.sync(resolve(dir, "**", "*"), {nodir: true})).flat();

                build.onResolve({ filter: /.*/ }, args => {
                    return {
                        watchFiles: extraFiles.concat([
                            resolve(config.src, "webapp", "index.html"),
                            resolve(config.src, "webapp", "index.css")
                        ], filesInDir),
                        watchDirs: extraDirs
                    };
                })
            },
        });
    }

    const options = {
        entryPoints: [ entrypoint ],
        outdir: config.public,
        entryNames: "index",
        format: "esm" as Format,
        splitting: true,
        bundle: true,
        minify: config.production,
        sourcemap: !config.production,

        external: getExternalModules(config.src),

        define: getProcessEnv(config),

        loader: {
            ".png": "file" as Loader,
            ".jpg": "file" as Loader,
            ".svg": "file" as Loader,
            ".md": "file" as Loader,
            ".ttf": "file" as Loader,
        },

        watch: watcher ? {
            onRebuild: async function(error, result){
                if (error) return;

                webAppPostBuild(config, watcher);

                watcher(true);
            }
        } : false,

        plugins
    }

    const result = await esbuild.build(options);

    if(result.errors.length > 0)
        return;

    if(!config.silent)
        console.log('\x1b[32m%s\x1b[0m', "WebApp Built");
}

const getDescendantByTag = (node, tag) => {
    for (let i = 0; i < node.childNodes?.length; i++) {
        if (node.childNodes[i].tagName === tag) return node.childNodes[i];

        const result = getDescendantByTag(node.childNodes[i], tag);
        if (result) return result;
    }

    return null;
};

export function webAppPostBuild(config: FullStackedConfig, watcher){
    const parser = new Parser();

    const userDefinedIndexHTMLFilePath = resolve(config.src, "webapp", "index.html");
    const root: any = fs.existsSync(userDefinedIndexHTMLFilePath)
        ? parse(fs.readFileSync(userDefinedIndexHTMLFilePath, {encoding: "utf-8"}))
        : parser.treeAdapter.createDocument();

    root.attrs = root.attrs ?? [];

    if(!getDescendantByTag(root, "html")){
        parser.treeAdapter.appendChild(root, parser.treeAdapter.createElement("html", html.NS.HTML, []));
    }

    const addInHEAD = (contentHTML: string) => {
        let head = getDescendantByTag(root, "head");
        if(!head){
            head = parser.treeAdapter.createElement("head", html.NS.HTML, []);
            parser.treeAdapter.appendChild(getDescendantByTag(root, "html"), head);
        }
        parseFragment(contentHTML).childNodes.forEach(node => {
            parser.treeAdapter.appendChild(head, node)
        });
    }

    const addInBODY = (contentHTML: string) => {
        let body = getDescendantByTag(root, "body");
        if(!body){
            body = parser.treeAdapter.createElement("body", html.NS.HTML, []);
            parser.treeAdapter.appendChild(getDescendantByTag(root, "html"), body);
        }
        parseFragment(contentHTML).childNodes.forEach(node => {
            parser.treeAdapter.appendChild(body, node)
        });
    }

    // add title
    if(!getDescendantByTag(root, "title")){
        addInHEAD(`<title>${config.title ?? config.name ?? "FullStacked WebApp"}</title>`);
    }

    // add js entrypoint
    addInBODY(`<script type="module" src="/index.js?v=${config.version + "-" + config.hash +
    (config.production ? "" : "-" + randStr(6) )}"></script>`);

    // if esbuild output any .css files, add them to index.html
    const builtCSSFiles = glob.sync("*.css", {cwd: config.public});
    builtCSSFiles.forEach(CSSFileName => addInHEAD(
        `<link rel="stylesheet" href="/${CSSFileName}?v=${config.version + "-" + config.hash + (config.production ? "" : "-" + randStr(6) )}">`
    ));


    // attach watcher if defined
    if(watcher){
        buildSync({
            entryPoints: [resolve(__dirname, "..", "webapp", "watcher.js")],
            outfile: resolve(config.public, "watcher.js"),
            format: "esm",
            bundle: true,
            minify: true,
            sourcemap: false
        });
        addInBODY(`<script type="module" src="/watcher.js"></script>`);
    }

    // add favicon if present
    const faviconFile = resolve(config.src, "webapp", "favicon.png");
    if(fs.existsSync(faviconFile)){
        // copy file to dist/public
        fs.copyFileSync(faviconFile, resolve(config.public, "favicon.png"));

        // add link tag in head
        addInHEAD(`<link rel="icon" href="/favicon.png">`);
    }

    // add app-icons dir if present
    const appIconsDir = resolve(config.src, "webapp", "app-icons");
    if(fs.existsSync(appIconsDir)){
        // copy file to dist/public
        copyRecursiveSync(appIconsDir, resolve(config.public, "app-icons"));
    }

    // index.css root file
    const CSSFile = resolve(config.src, "webapp", "index.css");
    if(fs.existsSync(CSSFile)){
        // make sure there is no overwriting
        let indexCSSCount = 0, CSSFileName = "index.css";
        while(fs.existsSync(resolve(config.public, CSSFileName))){
            indexCSSCount++;
            CSSFileName = `index-${indexCSSCount}.css`;
        }

        // copy file to dist/public
        fs.copyFileSync(CSSFile, resolve(config.public, CSSFileName));

        // add link tag
        addInHEAD(`<link rel="stylesheet" href="/${CSSFileName}?v=${config.version + "-" + config.hash +
        (config.production ? "" : "-" + randStr(6) )}">`);
    }

    // web app manifest
    const manifestFilePath = resolve(config.src, "webapp", "manifest.json");
    if(fs.existsSync(manifestFilePath)){
        // copy the file
        fs.cpSync(manifestFilePath, resolve(config.public, "manifest.json"));

        // add reference tag in head
        addInHEAD(`<link rel="manifest" href="/manifest.json" />`);
    }

    // build service-worker and reference in index.html
    const serviceWorkerFilePath = resolve(config.src, "webapp", "service-worker.ts");
    if(fs.existsSync(serviceWorkerFilePath)){
        // bundle service worker registration entrypoint to public dir
        buildSync({
            entryPoints: [resolve(__dirname, "..", "webapp", "serviceWorkerRegistration.js")],
            outfile: resolve(config.public, "service-worker.js"),
            define: getProcessEnv(config),
            format: "esm",
            bundle: true,
            minify: true,
            sourcemap: !config.production
        });

        // add reference tag in head
        addInHEAD(`<script type="module" src="/service-worker.js"></script>`);

        // build service worker scripts
        buildSync({
            entryPoints: [serviceWorkerFilePath],
            outfile: resolve(config.public, "service-worker-entrypoint.js"),
            bundle: true,
            minify: config.production,
            sourcemap: true
        });
    }

    // output index.html
    fs.mkdirSync(config.public, {recursive: true});
    fs.writeFileSync(resolve(config.public, "index.html"), serialize(root));
}

export default async function(config, watcher: (isWebApp: boolean) => void = null) {
    loadEnvVars(config.src);
    cleanOutDir(config.dist);

    const ignore = [
        "**/node_modules/**"
    ];

    if(config?.ignore){
        if(Array.isArray(config.ignore)) ignore.push(...config.ignore);
        else ignore.push(config.ignore);
    }

    // build server and webapp
    await Promise.all([
        buildServer(config, watcher),
        buildWebApp(config, watcher)
    ]);
}
