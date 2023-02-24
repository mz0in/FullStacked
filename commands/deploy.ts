import path, {dirname} from "path";
import fs from "fs";
import glob from "glob";
import {
    execScript, execSSH, getSFTPClient, askQuestion, getCertificateData,
    loadDataEncryptedWithPassword, saveDataEncryptedWithPassword, getBuiltDockerCompose
} from "../utils/utils";
import Build from "./build";
import yaml from "js-yaml";
import DockerInstallScripts from "../utils/dockerInstallScripts";
import { Writable } from "stream";
import CommandInterface from "./Interface";
import SFTP from "ssh2-sftp-client";
import {Client} from "ssh2";
import {certificate, DEPLOY_CMD, nginxConfig, nginxFile, sshCredentials} from "../types/deploy";
import {fileURLToPath} from "url";
import uploadFileWithProgress from "../utils/uploadFileWithProgress";
import randStr from "../utils/randStr";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type WrappedSFTP = SFTP & {
    client: Client
}

export default class Deploy extends CommandInterface {
    sftp: WrappedSFTP;
    configFilePath: string;

    sshCredentials: sshCredentials;
    nginxConfigs: nginxConfig[];
    certificate: certificate;

    constructor(config) {
        super(config);

        this.configFilePath = path.resolve(config.src, ".fullstacked");
    }

    /**
     *
     * Load saved configs
     *
     */
    loadConfigs(password){
        const {sshCredentials, nginxConfigs, certificate} = loadDataEncryptedWithPassword(this.configFilePath, password);

        this.sshCredentials = sshCredentials;
        this.nginxConfigs = nginxConfigs;
        this.certificate = certificate;

        console.log("Loaded deploy configuration");

        return {
            sshCredentials,
            nginxConfigs,
            certificate
        }
    }

    /**
     *
     * Save config to project
     *
     */
    async saveConfigs(password){
        saveDataEncryptedWithPassword(this.configFilePath, password, {
            sshCredentials: this.sshCredentials,
            nginxConfigs: this.nginxConfigs,
            certificate: this.certificate,
        })

        console.log("Saved deploy configuration");

        return true;
    }

    /**
     *
     * Get sftp client in less than 3s
     *
     */
    private async getSFTP(): Promise<WrappedSFTP>{
        if(this.sftp) return this.sftp;

        if(!this.sshCredentials)
            throw Error("Trying to get connection to remote server without having set ssh credentials");

        const timeout = setTimeout(() => {
            throw Error("Hanging 3s to connect to remote server");
        }, 3000);
        this.sftp = await getSFTPClient(this.sshCredentials);
        clearTimeout(timeout);

        return this.sftp;
    }

    /**
     *
     * Test out if your SSH credentials work with the remote host.
     * Make sure the App Directory is writable to publish web apps.
     * Make sure Docker and Docker Compose is installed on remote host.
     *
     */
    async testRemoteServer(){
        // reset sftp
        if(this.sftp) {
            await this.sftp.end();
            this.sftp = null;
        }

        console.log("Testing connection with remote host");
        this.sftp = await this.getSFTP();
        console.log("Success!");

        console.log("Testing mkdir in App Directory")
        const testDir = `${this.sshCredentials.appDir}/${randStr(10)}`;
        if(await this.sftp.exists(testDir)){
            throw Error(`Test directory ${testDir} exist. Exiting to prevent any damage to remote server.`);
        }

        await this.sftp.mkdir(testDir, true);
        await this.sftp.rmdir(testDir);
        console.log("Success!");

        return true;
    }

    /**
     *
     * Reusable function to test Docker and Docker Compose v2 installation on remote host
     *
     */
    private async testDockerOnRemoteHost(){
        const sftp = await this.getSFTP();

        const dockerTest = await execSSH(sftp.client, `docker version`);
        if(!dockerTest) {
            throw Error("Docker is not installed on the remote host.")
        }
        const dockerComposeTest = await execSSH(sftp.client, `docker compose version`);
        if(!dockerComposeTest){
            throw Error("Docker Compose v2 is not installed on the remote host.")
        }

        console.log("Docker and Docker Compose v2 is Installed");
        return true;
    }

    /**
     *
     * Try to install docker and docker-compose v2 on remote host for specific distro
     *
     */
    async tryToInstallDockerOnRemoteHost(){
        const sftp = await this.getSFTP();
        const distroNameRaw = await execSSH(sftp.client, "cat /etc/*-release");

        let distroName;
        if(distroNameRaw.includes("Amazon Linux release 2"))
            distroName = "Amazon Linux 2";
        else if(distroNameRaw.includes("Rocky Linux"))
            distroName = "Rocky Linux";
        else if(distroNameRaw.includes("Ubuntu"))
            distroName = "Ubuntu";
        else if(distroNameRaw.includes("Debian"))
            distroName = "Debian";

        if(!DockerInstallScripts[distroName])
            throw Error(`Don't know the command to install Docker and Docker Compose v2 on ${distroName || distroNameRaw}`);

        for(const cmd of DockerInstallScripts[distroName]) {
            console.log(cmd)
            await execSSH(sftp.client, cmd, this.write);
        }

        return await this.testDockerOnRemoteHost();
    }

    /**
     *
     * @return an array of available ports on remote host
     *
     */
    private async getAvailablePorts(sftp: WrappedSFTP, count: number, startingPort: number = 8001): Promise<string[]> {
        const dockerContainerPorts = await execSSH(sftp.client, "docker container ls --format \"{{.Ports}}\" -a");
        const portsInUse = dockerContainerPorts.split("\n").map(portUsed =>
            portUsed.split(":").pop().split("->").shift()) // each line looks like "0.0.0.0:8000->8000/tcp"
            .map(port => parseInt(port)) // cast to number
            .filter(port => port || !isNaN(port)); // filter empty strings

        const availablePorts = [];
        while (availablePorts.length < count){
            if(!portsInUse.includes(startingPort))
                availablePorts.push(startingPort);
            startingPort++;
        }

        return availablePorts;
    }

    /**
     *
     * Find available ports on remote host,
     * then setup docker-compose.yml and nginx-{service}-{port}.conf files.
     *
     */
    private async setupDockerComposeAndNginx(): Promise<nginxFile[]>{
        const sftp = await this.getSFTP();

        const dockerCompose = await getBuiltDockerCompose(this.config.src, true);
        // set default to node if no nginx configs
        const nginxConfigs = this.nginxConfigs || [{name: "node", port: 80}];
        const availablePorts = await this.getAvailablePorts(sftp, nginxConfigs.length);

        const nginxFiles: nginxFile[] = [];

        if(this.certificate){
            nginxFiles.push({
                fileName: "fullchain.pem",
                content: Buffer.from(this.certificate.fullchain)
            });
            nginxFiles.push({
                fileName: "privkey.pem",
                content: Buffer.from(this.certificate.privkey)
            });
            console.log("Added certificate")
        }

        const nginxTemplate = fs.readFileSync(path.resolve(__dirname, "..", "nginx", "service.conf"), {encoding: "utf-8"});
        const generateNginxFile = (publicPort , serverNames, internalPort, extraConfigs) => nginxTemplate
            .replace(/\{PUBLIC_PORT\}/g, publicPort)
            .replace(/\{SERVER_NAME\}/g, serverNames?.join(" ") ?? "localhost")
            .replace(/\{PORT\}/g, internalPort)
            .replace(/\{EXTRA_CONFIGS\}/g, extraConfigs?.join("\n") ?? "");

        const nginxSSLTemplate = fs.readFileSync(path.resolve(__dirname, "..", "nginx", "service-ssl.conf"), {encoding: "utf-8"});
        const generateNginxSSLFile = (publicPort , serverNames, internalPort, extraConfigs) => nginxSSLTemplate
            .replace(/\{PUBLIC_PORT\}/g, publicPort)
            .replace(/\{SERVER_NAME\}/g, serverNames?.join(" ") ?? "localhost")
            .replace(/\{PORT\}/g, internalPort)
            .replace(/\{EXTRA_CONFIGS\}/g, extraConfigs?.join("\n") ?? "")
            .replace(/\{APP_NAME\}/g, this.config.name);

        nginxConfigs.forEach((nginxConfig, configIndex) => {
            const availablePort = availablePorts[configIndex];

            if(nginxConfig.customPublicPort?.port){

                const customNginxFile = nginxConfig.customPublicPort.ssl
                    ? generateNginxSSLFile(nginxConfig.customPublicPort.port.toString(), nginxConfig.serverNames, availablePort, nginxConfig.nginxExtraConfigs)
                    : generateNginxFile(nginxConfig.customPublicPort.port.toString(), nginxConfig.serverNames, availablePort, nginxConfig.nginxExtraConfigs);

                nginxFiles.push({
                    fileName: `${nginxConfig.name}-${nginxConfig.port}.conf`,
                    content: Buffer.from(customNginxFile)
                });

            } else {
                nginxFiles.push({
                    fileName: `${nginxConfig.name}-${nginxConfig.port}.conf`,
                    content: Buffer.from(generateNginxFile("80", nginxConfig.serverNames, availablePort, nginxConfig.nginxExtraConfigs))
                });

                if(this.certificate){
                    nginxFiles.push({
                        fileName: `${nginxConfig.name}-${nginxConfig.port}-ssl.conf`,
                        content: Buffer.from(generateNginxSSLFile("443", nginxConfig.serverNames, availablePort, nginxConfig.nginxExtraConfigs))
                    });
                }
            }


            for (let i = 0; i < dockerCompose.services[nginxConfig.name].ports.length; i++) {
                if(dockerCompose.services[nginxConfig.name].ports[i] !== nginxConfig.port.toString()) continue;
                dockerCompose.services[nginxConfig.name].ports[i] = `${availablePort}:${nginxConfig.port}`;
            }
        });
        fs.writeFileSync(path.resolve(this.config.dist, "docker-compose.yml"), yaml.dump(dockerCompose));
        console.log("Generated docker-compose.yml");

        return nginxFiles;
    }

    /**
     *
     * Start up app on remote server
     *
     */
    async startAppOnRemoteServer(){
        const sftp = await this.getSFTP();

        console.log(`Starting ${this.config.name} v${this.config.version} on remote server`);
        await execSSH(sftp.client, `docker compose -p ${this.config.name} -f ${this.sshCredentials.appDir}/${this.config.name}/docker-compose.yml up -d`, this.write);
        await execSSH(sftp.client, `docker compose -p ${this.config.name} -f ${this.sshCredentials.appDir}/${this.config.name}/docker-compose.yml restart`, this.write);
    }

    /**
     *
     * Start FullStacked nginx on remote server
     *
     */
    async startFullStackedNginxOnRemoteHost(){
        const sftp = await this.getSFTP();

        const nginxDockerCompose = {
            services: {
                nginx: {
                    image: "nginx",
                    network_mode: "host",
                    container_name: "fullstacked-nginx",
                    volumes: [
                        "./:/apps",
                        "./root.conf:/etc/nginx/nginx.conf"
                    ],
                    restart: "always"
                }
            }
        };

        console.log(`Starting FullStacked Nginx on remote server`);
        await execSSH(sftp.client, `sudo chmod -R 755 ${this.sshCredentials.appDir}`);
        await sftp.put(path.resolve(__dirname, "..", "nginx", "root.conf"), `${this.sshCredentials.appDir}/root.conf`);
        await sftp.put(Buffer.from(yaml.dump(nginxDockerCompose)), `${this.sshCredentials.appDir}/docker-compose.yml`);
        await execSSH(sftp.client, `docker compose -p fullstacked-nginx -f ${this.sshCredentials.appDir}/docker-compose.yml up -d`, this.write);
        await execSSH(sftp.client, `docker compose -p fullstacked-nginx -f ${this.sshCredentials.appDir}/docker-compose.yml restart`, this.write);
    }

    async uploadFilesToRemoteServer(nginxFiles: nginxFile[]){
        const sftp = await this.getSFTP()

        if(!await sftp.exists(`${this.sshCredentials.appDir}/${this.config.name}`))
            await sftp.mkdir(`${this.sshCredentials.appDir}/${this.config.name}`, true);

        const files = glob.sync("**/*", {cwd: this.config.dist})
        const localFiles = files.map(file => path.resolve(this.config.dist, file));
        const remotePath = `${this.sshCredentials.appDir}/${this.config.name}`;

        for (let i = 0; i < files.length; i++) {
            const fileInfo = fs.statSync(localFiles[i]);
            if(fileInfo.isDirectory())
                await sftp.mkdir(remotePath + "/" + files[i]);
            else
                await uploadFileWithProgress(sftp, localFiles[i], remotePath + "/" + files[i], (progress) => {
                    this.printLine(`[${i + 1}/${files.length}] Uploading File ${progress.toFixed(2)}%`);
                });
        }

        const nginxRemoteDir = `${this.sshCredentials.appDir}/${this.config.name}/nginx`;
        if(!await sftp.exists(nginxRemoteDir))
            await sftp.mkdir(nginxRemoteDir, true);

        for (const nginxFile of nginxFiles){
            await sftp.put(nginxFile.content, `${nginxRemoteDir}/${nginxFile.fileName}`);
        }

        this.endLine();
    }


    /**
     *
     * Generate SSL certificate on remote host using certbot
     *
     */
    async generateCertificateOnRemoteHost(email: string, serverNames: string[]){
        const sftp = await this.getSFTP();
        console.log("Connected to remote host");

        let tempNginxDirRenamed = false;
        const nginxDir = `${this.sshCredentials.appDir}/${this.config.name}/nginx`;
        if(await sftp.exists(nginxDir)){
            tempNginxDirRenamed = true;
            await sftp.rename(nginxDir, `${this.sshCredentials.appDir}/${this.config.name}/_nginx`);
        }

        await sftp.mkdir(nginxDir, true);

        await sftp.put(Buffer.from(`server {
    listen              80;
    server_name         ${serverNames.join(" ")};
    root /apps/${this.config.name}/nginx;

    location / {
        try_files $uri $uri/ =404;
    }
}
`), `${nginxDir}/nginx.conf`);

        await this.startFullStackedNginxOnRemoteHost();
        console.log("Uploaded nginx setup");

        const command = [
            "docker run --rm --name certbot",
            `-v ${nginxDir}:/html`,
            `-v ${nginxDir}/certs:/etc/letsencrypt/archive`,
            `certbot/certbot certonly --webroot --agree-tos --no-eff-email -n -m ${email} -w /html`,
            `--cert-name certbot`,
            serverNames.map(serverName => `-d ${serverName}`).join(" ")
        ];

        await execSSH(sftp.client, command.join(" "), this.write);

        await execSSH(sftp.client, `sudo chmod 777 ${nginxDir} -R`);

        console.log("Downloading certificates");

        const fullchainPath = `${nginxDir}/certs/certbot/fullchain1.pem`;
        let fullchain = "";
        const stream = new Writable({
            write: function(chunk, encoding, next) {
                fullchain += chunk.toString();
                next();
            }
        });
        await sftp.get(fullchainPath, stream);

        const privkeyPath = `${nginxDir}/certs/certbot/privkey1.pem`;
        let privkey = "";
        const stream2 = new Writable({
            write: function(chunk, encoding, next) {
                privkey += chunk.toString()
                next();
            }
        });
        await sftp.get(privkeyPath, stream2);

        await sftp.rmdir(nginxDir, true);

        console.log("Cleaning Up");
        if(tempNginxDirRenamed){
            await sftp.rename(`${this.sshCredentials.appDir}/${this.config.name}/_nginx`, nginxDir);
        }

        console.log("Done");

        return {fullchain, privkey};
    }


    /**
     *
     * Core deploy method
     *
     */
    async run(tick?: () => void){
        await this.testRemoteServer();
        console.log("Connected to Remote Host");
        if(tick) tick();

        await this.testDockerOnRemoteHost();
        if(tick) tick();

        await Build({...this.config, silent: true, production: true});
        console.log(`Web App ${this.config.name} v${this.config.version} built production mode`);
        if(tick) tick();

        const nginxFiles = await this.setupDockerComposeAndNginx();
        console.log("Docker Compose and Nginx is setup");
        if(tick) tick();

        await this.uploadFilesToRemoteServer(nginxFiles);
        console.log("Web App is uploaded to the remote server");
        if(tick) tick();

        await execScript(path.resolve(this.config.src, "predeploy.ts"), this.config, await this.getSFTP());
        console.log("Ran predeploy scripts");
        if(tick) tick();

        await this.startAppOnRemoteServer();
        await this.startFullStackedNginxOnRemoteHost();
        console.log("Web App Deployed");
        if(tick) tick();

        await execScript(path.resolve(this.config.src, "postdeploy.ts"), this.config, await this.getSFTP());
        console.log("Ran postdeploy scripts");
        if(tick) tick();

        console.log("Deployment Successfull");
    }

    async runCLI(){
        if(!fs.existsSync(this.configFilePath)){
            console.log("No deploy config saved in project. Please run deployment with GUI once.")
            console.log("Run: npx fullstacked deploy --gui");
            return;
        }

        const password = this.config.password || await askQuestion("Password:", true);

        this.loadConfigs(password);

        await this.run();

        await this.sftp.end();
    }

    guiCommands() {
        return [
            {
                cmd: DEPLOY_CMD.CHECK_SAVED_CONFIG,
                callback: () => fs.existsSync(this.configFilePath)
            }, {
                cmd: DEPLOY_CMD.LOAD_CONFIG,
                callback: ({password}) => this.loadConfigs(password)
            },{
                cmd: DEPLOY_CMD.TEST_REMOTE_SERVER,
                callback: async ({sshCredentials}) => {
                    this.sshCredentials = sshCredentials;
                    return await this.testRemoteServer();
                }
            },{
                cmd: DEPLOY_CMD.TEST_DOCKER,
                callback: async () => await this.testDockerOnRemoteHost()
            },{
                cmd: DEPLOY_CMD.DOCKER_INSTALL,
                callback: async () => await this.tryToInstallDockerOnRemoteHost()
            },{
                cmd: DEPLOY_CMD.DOCKER_COMPOSE,
                callback: () => getBuiltDockerCompose(this.config.src, true)
            },{
                cmd: DEPLOY_CMD.DEPLOY,
                callback: async ({sshCredentials, nginxConfigs, certificate}, tick: () => void) => {
                    this.sshCredentials = sshCredentials;
                    this.nginxConfigs = nginxConfigs;
                    this.certificate = certificate;

                    await this.run(tick);
                }
            },{
                cmd: DEPLOY_CMD.CERT,
                callback: ({fullchain}) => getCertificateData(fullchain)
            },{
                cmd: DEPLOY_CMD.NEW_CERT,
                callback: async ({email, serverNames}) => await this.generateCertificateOnRemoteHost(email, serverNames)
            },{
                cmd: DEPLOY_CMD.SAVE,
                callback: async ({sshCredentials, nginxConfigs, certificate, password}) => {
                    this.sshCredentials = sshCredentials;
                    this.nginxConfigs = nginxConfigs;
                    this.certificate = certificate;
                    return await this.saveConfigs(password)
                }
            }
        ];
    }
}
