require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.render("index", {
        appName: process.env.APP_NAME || "LS Inventory",
        deviceName: process.env.DEVICE_NAME || "LS Cabinet 01"
    });
});

app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        application: "LS_Inventory",
        device: process.env.DEVICE_NAME || "LS Cabinet 01",
        time: new Date().toISOString()
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log("");
    console.log("=================================");
    console.log("       LS_Inventory Server");
    console.log("=================================");
    console.log(`Device : ${process.env.DEVICE_NAME}`);
    console.log(`Port   : ${PORT}`);
    console.log(`URL    : http://0.0.0.0:${PORT}`);
    console.log("=================================");
    console.log("");
});
