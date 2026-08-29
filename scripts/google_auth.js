const fs = require("fs");
const http = require("http");
const url = require("url");
const path = require("path");
const crypto = require("crypto");

const { google } = require("googleapis");

const ROOT = "/opt/LS_Inventory";

const CLIENT_FILE = path.join(
    ROOT,
    "config",
    "oauth-client.json"
);

const TOKEN_FILE = path.join(
    ROOT,
    "config",
    "google-token.json"
);

const SPREADSHEET_ID =
    process.env.SPREADSHEET_ID;

const PORT = 3001;

const REDIRECT_URI =
    `http://localhost:${PORT}`;

const SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets"
];

async function main() {

    console.log("");
    console.log("======================================");
    console.log(" LS_Inventory Google Authentication");
    console.log("======================================");
    console.log("");

    if (!SPREADSHEET_ID) {
        console.error(
            "ERROR: SPREADSHEET_ID belum tersedia."
        );

        console.error(
            "Jalankan: source .env"
        );

        process.exit(1);
    }

    if (!fs.existsSync(CLIENT_FILE)) {
        console.error(
            "ERROR: oauth-client.json tidak ditemukan:"
        );

        console.error(CLIENT_FILE);

        process.exit(1);
    }

    const credentials = JSON.parse(
        fs.readFileSync(
            CLIENT_FILE,
            "utf8"
        )
    );

    const config =
        credentials.installed ||
        credentials.web;

    if (!config) {
        console.error(
            "ERROR: Format OAuth client JSON tidak dikenali."
        );

        process.exit(1);
    }

    const oauth2Client =
        new google.auth.OAuth2(
            config.client_id,
            config.client_secret,
            REDIRECT_URI
        );

    /*
     * =====================================
     * TOKEN SUDAH ADA
     * =====================================
     */

    if (fs.existsSync(TOKEN_FILE)) {

        console.log(
            "Token Google ditemukan."
        );

        const token = JSON.parse(
            fs.readFileSync(
                TOKEN_FILE,
                "utf8"
            )
        );

        oauth2Client.setCredentials(
            token
        );

        await testSpreadsheet(
            oauth2Client
        );

        return;
    }

    /*
     * =====================================
     * OAUTH STATE
     * =====================================
     */

    const state =
        crypto.randomBytes(32).toString(
            "hex"
        );

    const authUrl =
        oauth2Client.generateAuthUrl({
            access_type: "offline",
            scope: SCOPES,
            include_granted_scopes: true,
            state: state
        });

    console.log(
        "Buka URL berikut di browser PC/Laptop:"
    );

    console.log("");
    console.log(authUrl);
    console.log("");

    console.log(
        "======================================"
    );

    console.log(
        `Menunggu callback di ${REDIRECT_URI}`
    );

    console.log(
        "======================================"
    );

    console.log("");

    /*
     * =====================================
     * CALLBACK SERVER
     * =====================================
     */

    const server =
        http.createServer(
            async (req, res) => {

                try {

                    const parsed =
                        url.parse(
                            req.url,
                            true
                        );

                    if (
                        parsed.pathname !== "/"
                    ) {

                        res.writeHead(404);

                        res.end(
                            "Not Found"
                        );

                        return;
                    }

                    const code =
                        parsed.query.code;

                    const returnedState =
                        parsed.query.state;

                    const error =
                        parsed.query.error;

                    if (error) {

                        res.writeHead(
                            400,
                            {
                                "Content-Type":
                                    "text/html"
                            }
                        );

                        res.end(
                            `<h2>Google Authorization Failed</h2>
                             <p>${escapeHtml(error)}</p>`
                        );

                        console.error(
                            "Google authorization error:",
                            error
                        );

                        server.close();

                        return;
                    }

                    if (
                        !returnedState ||
                        returnedState !== state
                    ) {

                        res.writeHead(400);

                        res.end(
                            "Invalid OAuth state."
                        );

                        console.error(
                            "ERROR: OAuth state tidak valid."
                        );

                        server.close();

                        return;
                    }

                    if (!code) {

                        res.writeHead(400);

                        res.end(
                            "Authorization code tidak ditemukan."
                        );

                        return;
                    }

                    console.log(
                        "Authorization code diterima."
                    );

                    const { tokens } =
                        await oauth2Client.getToken(
                            code
                        );

                    oauth2Client.setCredentials(
                        tokens
                    );

                    fs.writeFileSync(
                        TOKEN_FILE,
                        JSON.stringify(
                            tokens,
                            null,
                            2
                        ),
                        {
                            mode: 0o600
                        }
                    );

                    console.log("");
                    console.log(
                        "Google token berhasil disimpan."
                    );

                    console.log(
                        TOKEN_FILE
                    );

                    console.log("");

                    res.writeHead(
                        200,
                        {
                            "Content-Type":
                                "text/html; charset=utf-8"
                        }
                    );

                    res.end(`
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <meta charset="UTF-8">
                            <title>LS_Inventory</title>
                        </head>

                        <body style="
                            font-family: Arial;
                            text-align: center;
                            padding-top: 80px;
                        ">

                            <h1>
                                Google Authorization Successful
                            </h1>

                            <p>
                                Anda dapat menutup halaman ini.
                            </p>

                        </body>
                        </html>
                    `);

                    await testSpreadsheet(
                        oauth2Client
                    );

                    setTimeout(
                        () => server.close(),
                        1000
                    );

                } catch (error) {

                    console.error("");
                    console.error(
                        "OAuth callback error:"
                    );

                    console.error(
                        error.message
                    );

                    res.writeHead(
                        500,
                        {
                            "Content-Type":
                                "text/html"
                        }
                    );

                    res.end(
                        `<h2>Authorization Error</h2>
                         <p>${escapeHtml(
                             error.message
                         )}</p>`
                    );

                    server.close();
                }
            }
        );

    server.listen(
        PORT,
        "127.0.0.1",
        () => {

            console.log(
                `OAuth callback server aktif di ${REDIRECT_URI}`
            );

            console.log("");

            console.log(
                "Sekarang buka URL OAuth di browser PC."
            );

            console.log("");
        }
    );
}


/*
 * =========================================
 * TEST GOOGLE SHEETS
 * =========================================
 */

async function testSpreadsheet(auth) {

    console.log(
        "Testing Google Sheets connection..."
    );

    const sheets =
        google.sheets({
            version: "v4",
            auth: auth
        });

    try {

        const response =
            await sheets.spreadsheets.get({
                spreadsheetId:
                    SPREADSHEET_ID
            });

        console.log("");
        console.log(
            "======================================"
        );

        console.log(
            " GOOGLE SHEETS CONNECTION SUCCESS"
        );

        console.log(
            "======================================"
        );

        console.log("");

        console.log(
            "Spreadsheet:"
        );

        console.log(
            response.data.properties.title
        );

        console.log("");

        console.log(
            "Sheets:"
        );

        for (
            const sheet
            of response.data.sheets || []
        ) {

            console.log(
                "-",
                sheet.properties.title
            );
        }

        console.log("");

        console.log(
            "LS_Inventory berhasil terhubung ke Google Sheets."
        );

        console.log("");

    } catch (error) {

        console.error("");
        console.error(
            "Google Sheets connection FAILED."
        );

        console.error("");

        if (
            error.response &&
            error.response.data
        ) {

            console.error(
                JSON.stringify(
                    error.response.data,
                    null,
                    2
                )
            );

        } else {

            console.error(
                error.message
            );
        }

        process.exit(1);
    }
}


/*
 * =========================================
 * ESCAPE HTML
 * =========================================
 */

function escapeHtml(text) {

    return String(text)
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /'/g,
            "&#039;"
        );
}


/*
 * =========================================
 * START
 * =========================================
 */

main().catch(
    (error) => {

        console.error("");

        console.error(
            "FATAL ERROR:"
        );

        console.error(
            error
        );

        process.exit(1);
    }
);
