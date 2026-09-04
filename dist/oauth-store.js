import { randomUUID } from "node:crypto";
import { InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { openDatabase } from "./db/client.js";
function redirectHostAllowed(redirectUri, allowedHosts) {
    let parsed;
    try {
        parsed = new URL(redirectUri);
    }
    catch {
        return false;
    }
    if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
        return true;
    return allowedHosts.includes(parsed.hostname);
}
export class SqliteOAuthStore {
    database;
    constructor(stateDir) {
        this.database = openDatabase(stateDir);
        this.deleteExpiredTokens(Math.floor(Date.now() / 1000));
        this.deleteExpiredAuthorizationCodes(Date.now());
    }
    getClient(clientId) {
        const row = this.database.sqlite
            .prepare("select client_json from oauth_clients where client_id = ?")
            .get(clientId);
        return row ? JSON.parse(row.client_json) : undefined;
    }
    registerClient(client, allowedRedirectHosts) {
        if (!client.redirect_uris.every((uri) => redirectHostAllowed(String(uri), allowedRedirectHosts))) {
            throw new InvalidRequestError("Client redirect_uri is not allowed for this DevSpace server");
        }
        const now = Math.floor(Date.now() / 1000);
        const registered = {
            ...client,
            client_id: `devspace-${randomUUID()}`,
            client_id_issued_at: now,
            token_endpoint_auth_method: client.token_endpoint_auth_method ?? "none",
            grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
            response_types: client.response_types ?? ["code"],
        };
        this.database.sqlite
            .prepare("insert into oauth_clients (client_id, client_json, issued_at) values (?, ?, ?)")
            .run(registered.client_id, JSON.stringify(registered), now);
        return registered;
    }
    saveAccessToken(tokenHash, record) {
        this.database.sqlite
            .prepare(`insert into oauth_access_tokens (token_hash, client_id, scopes_json, expires_at, resource)
         values (?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource`)
            .run(tokenHash, record.clientId, JSON.stringify(record.scopes), record.expiresAt, record.resource ?? null);
    }
    getAccessToken(tokenHash) {
        const row = this.database.sqlite
            .prepare("select client_id, scopes_json, expires_at, resource from oauth_access_tokens where token_hash = ?")
            .get(tokenHash);
        return row ? rowToAccessTokenRecord(row) : undefined;
    }
    deleteAccessToken(tokenHash) {
        this.database.sqlite.prepare("delete from oauth_access_tokens where token_hash = ?").run(tokenHash);
    }
    saveRefreshToken(tokenHash, record) {
        this.database.sqlite
            .prepare(`insert into oauth_refresh_tokens (token_hash, client_id, scopes_json, expires_at, resource)
         values (?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource`)
            .run(tokenHash, record.clientId, JSON.stringify(record.scopes), record.expiresAt, record.resource ?? null);
    }
    saveTokenPair(pair, consumedRefreshTokenHash) {
        const save = this.database.sqlite.transaction(() => {
            if (consumedRefreshTokenHash) {
                const result = this.database.sqlite
                    .prepare("delete from oauth_refresh_tokens where token_hash = ?")
                    .run(consumedRefreshTokenHash);
                if (result.changes !== 1)
                    return false;
            }
            this.saveAccessToken(pair.accessTokenHash, pair.accessToken);
            this.saveRefreshToken(pair.refreshTokenHash, pair.refreshToken);
            return true;
        });
        return save.immediate();
    }
    getRefreshToken(tokenHash) {
        const row = this.database.sqlite
            .prepare("select client_id, scopes_json, expires_at, resource from oauth_refresh_tokens where token_hash = ?")
            .get(tokenHash);
        return row ? rowToRefreshTokenRecord(row) : undefined;
    }
    deleteRefreshToken(tokenHash) {
        this.database.sqlite.prepare("delete from oauth_refresh_tokens where token_hash = ?").run(tokenHash);
    }
    saveAuthorizationCode(codeHash, record) {
        this.database.sqlite
            .prepare(`insert into oauth_authorization_codes (code_hash, client_id, params_json, expires_at_ms)
         values (?, ?, ?, ?)
         on conflict(code_hash) do update set
           client_id = excluded.client_id,
           params_json = excluded.params_json,
           expires_at_ms = excluded.expires_at_ms`)
            .run(codeHash, record.clientId, JSON.stringify(record.params), record.expiresAtMs);
    }
    getAuthorizationCode(codeHash) {
        const row = this.database.sqlite
            .prepare("select client_id, params_json, expires_at_ms from oauth_authorization_codes where code_hash = ?")
            .get(codeHash);
        return row ? rowToAuthorizationCodeRecord(row) : undefined;
    }
    consumeAuthorizationCode(codeHash) {
        const consume = this.database.sqlite.transaction(() => {
            const row = this.database.sqlite
                .prepare("select client_id, params_json, expires_at_ms from oauth_authorization_codes where code_hash = ?")
                .get(codeHash);
            if (!row)
                return undefined;
            const deleted = this.database.sqlite
                .prepare("delete from oauth_authorization_codes where code_hash = ?")
                .run(codeHash);
            if (deleted.changes !== 1)
                return undefined;
            return rowToAuthorizationCodeRecord(row);
        });
        return consume.immediate();
    }
    close() {
        this.database.close();
    }
    deleteExpiredTokens(nowSeconds) {
        this.database.sqlite.prepare("delete from oauth_access_tokens where expires_at < ?").run(nowSeconds);
        this.database.sqlite.prepare("delete from oauth_refresh_tokens where expires_at < ?").run(nowSeconds);
    }
    deleteExpiredAuthorizationCodes(nowMs) {
        this.database.sqlite.prepare("delete from oauth_authorization_codes where expires_at_ms < ?").run(nowMs);
    }
}
export class SqliteOAuthClientsStore {
    store;
    allowedRedirectHosts;
    constructor(store, allowedRedirectHosts) {
        this.store = store;
        this.allowedRedirectHosts = allowedRedirectHosts;
    }
    getClient(clientId) {
        return this.store.getClient(clientId);
    }
    registerClient(client) {
        return this.store.registerClient(client, this.allowedRedirectHosts);
    }
}
function rowToAccessTokenRecord(row) {
    return {
        clientId: row.client_id,
        scopes: JSON.parse(row.scopes_json),
        expiresAt: row.expires_at,
        resource: row.resource ?? undefined,
    };
}
function rowToRefreshTokenRecord(row) {
    return {
        clientId: row.client_id,
        scopes: JSON.parse(row.scopes_json),
        expiresAt: row.expires_at,
        resource: row.resource ?? undefined,
    };
}
function rowToAuthorizationCodeRecord(row) {
    return {
        clientId: row.client_id,
        params: JSON.parse(row.params_json),
        expiresAtMs: row.expires_at_ms,
    };
}
