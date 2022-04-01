import * as assert from "assert";
import {describe} from "mocha";
import child_process from "child_process";
import fs from "fs";
import path from "path";
import TestE2E from "tests/TestE2E";
import {sleep} from "tests/utils";

describe("Create Test", function(){
    const webAppFile = path.resolve(__dirname, "index.tsx");
    const serverFile = path.resolve(__dirname, "server.ts");
    let test;

    it('Should create the default starter file', function(){
        const logMessage = child_process.execSync(`fullstacked create --src=${__dirname} --silent`).toString();
        if(logMessage)
            console.log(logMessage);

        assert.ok(fs.existsSync(webAppFile));
        assert.ok(fs.existsSync(serverFile));
    });

    it('Should display the default starter app', async function (){
        test = new TestE2E(__dirname);
        await test.start();
        await sleep(500);
        const root = await test.page.$("#root");
        const innerHTML = await root.getProperty('innerHTML');
        const value = await innerHTML.jsonValue();
        assert.equal(value, "<div>Welcome to FullStacked!</div>");
    });

    after(async () => {
        await test.stop();

        const files = [webAppFile, serverFile];

        files.forEach(file => {
            if(fs.existsSync(file))
                fs.rmSync(file);
        });
    });
});
