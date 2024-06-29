import config from "./config.json";
import Bun from "bun";

const rateLimits = {};
const clients = [];

const checkboxesFile = Bun.file("checkboxes.json");
const checkboxesData = await checkboxesFile.exists() ? await checkboxesFile.json() : { length: config.checkboxes, checkboxes: new Array(config.checkboxes).fill(0) }; // Reads checkboxes.json file if exists else new object
if (checkboxesData.length !== config.checkboxes || checkboxesData.checkboxes.length != config.checkboxes) {
    // If amount of checkboxes don't match the amount set in config
    checkboxesData.length = config.checkboxes; // Change length
    // Slice/fill checkboxes
    checkboxesData.checkboxes = checkboxesData.checkboxes.length > config.checkboxes
        ? checkboxesData.checkboxes.slice(0, config.checkboxes) // Remove extra checkboxes
        : [...checkboxesData.checkboxes, ...new Array(config.checkboxes - checkboxesData.checkboxes.length).fill(0)]; // Add more checkboxes
}

// Serve HTTP server
Bun.serve({
    port: config.port,
    hostname: config.hostname,
    tls: (config.key && config.cert) ? {
        key: Bun.file(config.key),
        cert: Bun.file(config.cert)
    } : undefined,

    async fetch(req, server) {
        // Constant responses
        const badRequest = new Response(JSON.stringify({ success: false, message: "Bad Request" }), { status: 400, headers: { "Content-Type": "application/json" } });
        const notFound = new Response(null, { status: 301, headers: { Location: "/" } });
        const rateLimit = new Response(JSON.stringify({ success: false, message: `You are being rate limited, try again in ${Math.ceil(config.rateLimit.resetTimeout / 1000)} seconds!` }), { status: 429, headers: { "Content-Type": "application/json" } });

        const ip = server.requestIP(req);
        const method = req.method;
        const url = new URL(req.url);
        let json;
        if (req.body) json = await req.json().catch();

        // /
        if (url.pathname == "/" && method == "GET") return new Response(Bun.file("index.html"));
        // /checkboxes
        if (url.pathname == "/checkboxes" && method == "GET") return new Response(JSON.stringify(checkboxesData), { headers: { "Content-Type": "application/json" } });
        
        // Apply rate limit here
        if (rateLimits[ip.address]) { if (rateLimits[ip.address].requests >= config.rateLimit.maxRequests) return rateLimit; rateLimits[ip.address].requests++; clearTimeout(rateLimits[ip.address].timeout) } else rateLimits[ip.address] = { requests: 1 };
        rateLimits[ip.address].timeout = setTimeout(() => delete rateLimits[ip.address], config.rateLimit.resetTimeout);
        
        // set-checkbox
        if (url.pathname == "/set-checkbox" && method == "POST") {
            if (json?.state != undefined && typeof json?.checkbox == "number" && json?.checkbox < config.checkboxes && json?.checkbox >= 0) {
                updateCheckbox(json.checkbox, json.state);
                return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
            } else return badRequest;
        };
        // /ws
        if (url.pathname == "/ws") return server.upgrade(req) ? null : error;

        // 404
        return notFound;
    },
    websocket: {
        open(ws) {
            ws.send(JSON.stringify({ type: "hello", data: { heartbeatInterval: config.heartbeatInterval } })); // Send hello event with heartbeat interval
            ws.heartbeatSendInterval = setInterval(() => ws.send(JSON.stringify({ type: "heartbeat" })), config.heartbeatInterval); // Create interval to send heartbeats
            ws.heartbeatTimeout = setTimeout(() => ws.close(), config.heartbeatInterval + config.heartbeatIntervalDiff); // Create timeout to close if no heartbeats received
            clients.push(ws); // Push client to array
        },
        message(ws, message) {
            let json;
            try { json = JSON.parse(message) } catch (err) { };
            if (!json) return;

            if (json?.type == "heartbeat") {
                clearTimeout(ws.heartbeatTimeout);
                ws.heartbeatTimeout = setTimeout(() => ws.close(), config.heartbeatInterval + config.heartbeatIntervalDiff);
            }
        },
        close(ws) {
            const clientIndex = clients.findIndex(i => i == ws);
            if (clientIndex != -1) clients.splice(clientIndex, 1);
        }
    }
});

// Send message to all clients when a checkbox has been changed
function updateCheckbox(checkbox, state) {
    state = state ? 1 : 0;
    checkboxesData.checkboxes[checkbox] = state;
    clients.forEach(client => client.send(JSON.stringify({ type: "checkbox-update", data: { checkbox, state } })));
}

// Save checkboxes data to checkboxes.json every x milliseconds
setInterval(() => {
    Bun.write(checkboxesFile, JSON.stringify(checkboxesData));
}, config.saveInterval);