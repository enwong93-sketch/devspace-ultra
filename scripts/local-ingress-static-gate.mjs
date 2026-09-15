import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const path = new URL("./devspace-local-ingress.ps1", import.meta.url);
let source = "";
try { source = await readFile(path, "utf8"); } catch {}

assert.match(source, /DevSpace-Local-Ingress/, "local ingress must have its own persistent Scheduled Task identity");
assert.match(source, /ValidateSet\("install",\s*"adopt"/, "existing protected ingress configuration must support a non-secret adoption path after a source upgrade");
assert.match(source, /ConvertFrom-SecureString/, "DuckDNS token must be persisted with Windows DPAPI rather than plaintext");
assert.match(source, /ConvertTo-SecureString/, "runtime must decrypt the DPAPI token only in memory");
assert.match(source, /ReadAllText\(\$configPath,\s*\[System\.Text\.Encoding\]::UTF8\)/, "UTF-8 configuration must round-trip non-ASCII Windows interface aliases under Windows PowerShell 5");
assert.doesNotMatch(source, /api\.ipify|ifconfig\.me|checkip/i, "DDNS must never learn the Surfshark egress IP from a generic internet-IP service");
assert.match(source, /GetExternalIPAddress/, "runtime must read the real WAN IP from the home router");
assert.match(source, /GetSpecificPortMappingEntry/, "runtime must inspect existing router mappings before changing them");
assert.match(source, /AddPortMapping/, "runtime must ensure TCP 80/443 map to the current LAN address");
assert.match(source, /DeletePortMapping/, "runtime must replace only its own stale mapping when the DHCP address changes");
assert.match(source, /DevSpace-Caddy-/, "UPnP mappings must carry an ownership description so unrelated mappings are never overwritten");
assert.match(source, /www\.duckdns\.org\/update/, "runtime must update DuckDNS directly");
assert.match(source, /lastWanIp|LastWanIp/, "DuckDNS updates must be change-driven rather than high-frequency unconditional polling");
assert.match(source, /caddy[^\r\n]*run|Start-Caddy/i, "runtime must own the Caddy process lifecycle");
assert.match(source, /\/browser-control/, "generated Caddy config must keep internal browser-control surfaces outside the public allowlist");
assert.match(source, /mcp-app-assets/, "generated Caddy config must expose MCP App assets required by ChatGPT");
assert.match(source, /New-NetFirewallRule[\s\S]*80,443|LocalPort[^\r\n]*80,443/, "installer must constrain Windows ingress to Caddy TCP 80/443");
assert.match(source, /InterfaceAlias/, "firewall and LAN discovery must stay bound to the selected physical interface");
assert.match(source, /ExecutionTimeLimit[\s\S]*(Seconds 0|TimeSpan::Zero)|New-TimeSpan -Seconds 0/, "Scheduled Task must be allowed to run continuously");
assert.match(source, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/, "Scheduled Task must use the real Windows PowerShell host rather than assuming the current PowerShell installation layout");
assert.doesNotMatch(source, /Write-(Host|Output)[^\r\n]*(token|DuckDnsToken)/i, "token value must never be printed");

console.log(JSON.stringify({ ok: true, gate: "local-ingress-static", dpapi: true, routerWanAuthoritative: true, quotaFreeHotPath: true }));
