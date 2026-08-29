require("dotenv").config({
    path: "/opt/LS_Inventory/.env"
});

const fs = require("fs");
const path = require("path");
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


async function main() {

    console.log("");
    console.log("======================================");
    console.log(" LS_Inventory Google Sheets Test");
    console.log("======================================");
    console.log("");

    /*
     * ================================
     * VALIDATION
     * ================================
     */

    if (!SPREADSHEET_ID) {

        throw new Error(
            "SPREADSHEET_ID belum tersedia di .env"
        );

    }

    if (!fs.existsSync(CLIENT_FILE)) {

        throw new Error(
            `OAuth client tidak ditemukan: ${CLIENT_FILE}`
        );

    }

    if (!fs.existsSync(TOKEN_FILE)) {

        throw new Error(
            `Google token tidak ditemukan: ${TOKEN_FILE}`
        );

    }

    console.log("Spreadsheet ID : OK");
    console.log("OAuth Client   : OK");
    console.log("OAuth Token    : OK");

    /*
     * ================================
     * LOAD OAUTH CLIENT
     * ================================
     */

    const clientData = JSON.parse(
        fs.readFileSync(
            CLIENT_FILE,
            "utf8"
        )
    );

    const clientConfig =
        clientData.installed ||
        clientData.web;

    if (!clientConfig) {

        throw new Error(
            "Format oauth-client.json tidak valid."
        );

    }

    /*
     * ================================
     * CREATE OAUTH CLIENT
     * ================================
     */

    const oauth2Client =
        new google.auth.OAuth2(
            clientConfig.client_id,
            clientConfig.client_secret,
            clientConfig.redirect_uris?.[0]
                || "http://localhost"
        );

    /*
     * ================================
     * LOAD TOKEN
     * ================================
     */

    const tokenData = JSON.parse(
        fs.readFileSync(
            TOKEN_FILE,
            "utf8"
        )
    );

    oauth2Client.setCredentials(
        tokenData
    );

    /*
     * ================================
     * AUTO SAVE REFRESHED TOKEN
     * ================================
     */

    oauth2Client.on(
        "tokens",
        (tokens) => {

            const currentToken =
                JSON.parse(
                    fs.readFileSync(
                        TOKEN_FILE,
                        "utf8"
                    )
                );

            const updatedToken = {
                ...currentToken,
                ...tokens
            };

            fs.writeFileSync(
                TOKEN_FILE,
                JSON.stringify(
                    updatedToken,
                    null,
                    2
                ),
                {
                    mode: 0o600
                }
            );

            console.log(
                "Google OAuth token diperbarui."
            );

        }
    );

    /*
     * ================================
     * GOOGLE SHEETS CLIENT
     * ================================
     */

    const sheets =
        google.sheets({
            version: "v4",
            auth: oauth2Client
        });

    console.log("");
    console.log(
        "Menghubungkan ke Google Spreadsheet..."
    );

    /*
     * ================================
     * TEST SPREADSHEET
     * ================================
     */

    const response =
        await sheets.spreadsheets.get({
            spreadsheetId:
                SPREADSHEET_ID,

            fields:
                "spreadsheetId,properties(title),sheets.properties(title)"
        });

    /*
     * ================================
     * SUCCESS
     * ================================
     */

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
        "Spreadsheet :",
        response.data.properties.title
    );

    console.log(
        "Spreadsheet ID :",
        response.data.spreadsheetId
    );

    console.log("");
    console.log("Sheets:");

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
        "LS_Inventory berhasil terhubung ke Google Spreadsheet."
    );

    console.log("");

}


main().catch(
    (error) => {

        console.error("");
        console.error(
            "======================================"
        );

        console.error(
            " GOOGLE SHEETS CONNECTION FAILED"
        );

        console.error(
            "======================================"
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
);
