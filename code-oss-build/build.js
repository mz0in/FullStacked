import fs from "fs";
import https from "https";
import decompress from "decompress";
import {execSync} from "child_process";

const platform = "darwin-x64";
const vscodeRelease = "https://codeload.github.com/microsoft/vscode/zip/refs/tags/1.82.1";

const file = fs.createWriteStream("vscode.zip");
await new Promise(resolve => {
    https.get(vscodeRelease, response => {
        response.pipe(file);
        file.on("finish", () => {
            file.close();
            resolve();
        });
    });
});

await decompress("vscode.zip", "vscode")

const versionedDir = fs.readdirSync("vscode").at(0)
fs.readdirSync(`vscode/${versionedDir}`).forEach(item => fs.renameSync(`vscode/${versionedDir}/${item}`, `vscode/${item}`));
fs.rmSync(`vscode/${versionedDir}`, {recursive: true});

const productJSON = JSON.parse(fs.readFileSync("vscode/product.json").toString());
productJSON.extensionsGallery = {
    serviceUrl: "https://open-vsx.org/vscode/gallery",
    itemUrl: "https://open-vsx.org/vscode/item",
    resourceUrlTemplate: "https://open-vsx.org/vscode/asset/{publisher}/{name}/{version}/Microsoft.VisualStudio.Code.WebResources/{path}",
    controlUrl: "",
    recommendationsUrl: ""
}
fs.writeFileSync("vscode/product.json", JSON.stringify(productJSON, null, 2));

fs.appendFileSync("vscode/src/vs/workbench/browser/actions/windowActions.ts", fs.readFileSync("blurFocus.js").toString());

const themeConfigsFile = "vscode/src/vs/workbench/services/themes/common/themeConfiguration.ts";
const themeConfigs = fs.readFileSync(themeConfigsFile).toString();
const codeBlockMatch = themeConfigs.match(/detectColorSchemeSettingSchema(.|\r|\n)*?default: false\n};/);
if(codeBlockMatch){
    const updatedCodeBlock = codeBlockMatch[0].replace("default: false", "default: true");
    fs.writeFileSync(themeConfigsFile, themeConfigs.replace(codeBlockMatch[0], updatedCodeBlock));
}

execSync(`cd vscode && yarn && yarn gulp vscode-reh-web-${platform}-min`, {stdio: "inherit"});

fs.rmSync(`vscode-reh-web-${platform}/node`);
fs.rmSync(`vscode-reh-web-${platform}/node_modules`, {recursive: true});

const remotePackageJSON = JSON.parse(fs.readFileSync("vscode/remote/package.json").toString());
const outPackageJSON = JSON.parse(fs.readFileSync(`vscode-reh-web-${platform}/package.json`).toString());
fs.writeFileSync(`vscode-reh-web-${platform}/package.json`, JSON.stringify({
    ...outPackageJSON,
    dependencies: remotePackageJSON.dependencies
}, null, 2));

fs.rmSync("vscode.zip");
fs.rmSync("vscode", {recursive: true});

if(fs.existsSync("../code-oss"))
    fs.rmSync("../code-oss", {recursive: true});
fs.renameSync(`vscode-reh-web-${platform}`, "../code-oss");
