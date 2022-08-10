import {FullStackedConfig} from "../index";
import fs from "fs";
import path from "path";
import yaml from "yaml";
import {execSync} from "child_process";
import {execSSH} from "./utils";

export default function (config: FullStackedConfig) {
    const dockerComposeFile = path.resolve(config.dist, "docker-compose.yml");

    if(!fs.existsSync(dockerComposeFile))
        return console.log("Could not find built docker-compose file");

    const dockerCompose = yaml.parse(fs.readFileSync(dockerComposeFile, {encoding: "utf-8"}));
    const volumes = Object.keys(dockerCompose.volumes);

    if(!config.volume || !volumes.includes(config.volume))
        return console.log("Volume not found in current docker-compose running");

    execSync(`docker-compose -p ${config.name} -f ${dockerComposeFile} stop`);
    execSync(`docker-compose -p ${config.name} -f ${dockerComposeFile} rm -f`);

    execSync(`docker run -v ${config.name + "_" + config.volume}:/data -v ${config.backupDir ?? config.dist}/backup:/backup --name=fullstacked-restore busybox sh -c "cd data && rm -rf ./* && tar xvf /backup/${config.volume}.tar --strip 1"`, {
        stdio: config.silent ? "ignore" : "inherit"
    });

    execSync(`docker rm fullstacked-restore -f`);

    execSync(`docker-compose -p ${config.name} -f ${dockerComposeFile} up -d`);
}
