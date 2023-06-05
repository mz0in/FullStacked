import React, {createRef, useEffect, useState} from "react";
import WinBox from "winbox/src/js/winbox";
import ButtonIcon from "../components/button-icon";
//@ts-ignore
import loading from "../icons/loading.gif";
//@ts-ignore
import browser from "../icons/browser.svg";
//@ts-ignore
import terminal from "../icons/terminal.svg";
//@ts-ignore
import files from "../icons/files.svg";
//@ts-ignore
import logo from "../icons/fullstacked-logo.svg";
//@ts-ignore
import logout from "../icons/log-out.svg";
//@ts-ignore
import codeServer from "../icons/code-server.png";
//@ts-ignore
import docker from "../icons/docker.svg";
import {createRoot} from "react-dom/client";
import Files from "./files";
import Browser from "../browser";
import {getWidth} from "./WinStore";
import {client} from "../client";
import Terminal from "../terminal";
import useAPI from "@fullstacked/webapp/client/react/useAPI";

function initZoneSelect(){
    let mouseStart = null, square = null;
    const onMouseDown = (e) => {
        if(e.button !== 0) return;
        mouseStart = [e.clientX, e.clientY]
    }
    const onMouseMove = (e) => {
        if(!mouseStart) return;
        if(!square) {
            square = document.createElement("div");
            square.classList.add("select-zone");
            document.body.append(square);
        }

        const mousePos = [e.clientX, e.clientY];

        square.style.left = Math.min(mouseStart[0], mousePos[0]) + "px";
        square.style.top = Math.min(mouseStart[1], mousePos[1]) + "px";
        square.style.width = Math.abs(mouseStart[0] - mousePos[0]) + "px";
        square.style.height = Math.abs(mouseStart[1] - mousePos[1]) + "px";
    }
    const onMouseUp   = () => {
        if(square)
            square.remove();
        mouseStart = null;
        square = null;
    }
    document.querySelector(".background").addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
}

const winOptions = {
    x: "center",
    y: "center",
    width: getWidth()
}

async function checkForPapercups(){
    const papercupsEndpoint = await client.get().papercupsURL();
    if(!papercupsEndpoint) return;
    //@ts-ignore
    window.Papercups = {
        config: {
            accountId: "53fcfc2e-6010-408d-8bc0-d6144ff10b13",
            publicKey: "xyz",
            token: "53fcfc2e-6010-408d-8bc0-d6144ff10b13",
            inbox: "c36e4568-39b2-4c21-9d02-b8c05e59418e",
            title: 'FullStacked Cloud Support',
            subtitle: 'Ask us anything 😊',
            newMessagePlaceholder: 'Start typing...',
            primaryColor: '#3eb0de',
            greeting: 'Hi there! How can I help you?',
            customer: {},
            iconVariant: "filled",
            baseUrl: papercupsEndpoint,
            showAgentAvailability: true,
        },
    };
    const scriptTag = document.createElement("script");
    scriptTag.src = `${papercupsEndpoint}/widget.js`;
    document.body.append(scriptTag);
    const scriptTag2 = document.createElement("script");
    scriptTag2.src = `${papercupsEndpoint}/storytime.js`;
    document.body.append(scriptTag2);
}

export default function () {
    const [hasCodeServer] = useAPI(client.get().hasCodeServer);
    useEffect(initZoneSelect, []);
    useEffect(() => {checkForPapercups()}, []);


    const apps: {
        icon: string,
        title: string,
        onClick(): void,
    }[] = [
        {
            icon: terminal,
            title: "Terminal",
            onClick() {
                const div = document.createElement("div");
                const terminalRef = createRef<Terminal>();
                new WinBox("Terminal", {
                    ...winOptions,
                    mount: div,
                    onresize: () => {
                        setTimeout(() => {
                            terminalRef?.current?.onResize()
                        }, 500)
                    },
                    onfullscreen: () => {
                        setTimeout(() => {
                            terminalRef?.current?.onResize()
                        }, 500)
                    },
                });
                createRoot(div).render(<Terminal ref={terminalRef} />);
            }
        },
        {
            icon: files,
            title: "Explorer",
            onClick() {
                const div = document.createElement("div");
                new WinBox("Files", {...winOptions, mount: div});
                createRoot(div).render(<Files />);
            }
        },
        {
            icon: browser,
            title: "Browser",
            onClick() {
                const div = document.createElement("div");
                new WinBox("Browser", {...winOptions, mount: div});
                createRoot(div).render(<Browser />);
            }
        }
    ]

    if(window.localStorage.getItem("fullstackedRefreshToken")){
        apps.unshift({
            title: "Logout",
            icon: logout,
            async onClick() {
                await client.get().logout(window.localStorage.getItem("fullstackedRefreshToken"));
                window.localStorage.removeItem("fullstackedRefreshToken")
                window.location.href = "/?logout=1";
            }
        })
    }

    if(hasCodeServer){
        apps.push({
            icon: codeServer,
            title: "Code",
            onClick() {
                const iframe = document.createElement("iframe");
                iframe.style.backgroundImage = `url(${loading})`;
                // @ts-ignore
                // iframe.credentialless = true;
                new WinBox("Code Server", {
                    ...winOptions,
                    mount: iframe
                });
                iframe.src = (window.hasCredentialless
                    ? new URL(`${window.location.protocol}//${window.location.host}?port=8888`)
                    : new URL(`${window.location.protocol}//8888.${window.location.host}`)).toString();
            }
        })
    }

    return <>
        <div className={"background"}>
            <img src={logo}/>
        </div>
        {apps.map((app, i) => <ButtonIcon
            icon={app.icon}
            title={app.title}
            top={i * 80}
            left={0}
            onClick={app.onClick}
        />)}
    </>
}
