import {describe, it, before, after} from 'mocha';
import {equal} from "assert";
import {exec} from "child_process";
import path, {dirname} from "path";
import puppeteer from "puppeteer";
import sleep from "../../../utils/sleep.js";
import {cleanOutDir} from "../../../utils/utils.js";
import waitForServer from "../../../utils/waitForServer.js";
import {fileURLToPath} from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Run Test", function(){
    let runProcess, browser, page;

    before(async function (){
        runProcess = exec(`node ${path.resolve(__dirname, "../../../cli")} run --src=${__dirname} --out=${__dirname} --silent`);
        await waitForServer(10000);
        browser = await puppeteer.launch({headless: process.argv.includes("--headless")});
        page = await browser.newPage();
        await page.goto("http://localhost:8000");
    })

    it('Should run a basic web page', async function(){
        const root = await page.$("fullstacked-element");
        const innerHTML = await root.getProperty('innerHTML');
        const value = await innerHTML.jsonValue();
        equal(value, "Run Test");
    });

    after(async function(){
        await browser.close();
        runProcess.kill("SIGINT");

        await sleep(3000);

        cleanOutDir(path.resolve(__dirname, "dist"));
    });
});
