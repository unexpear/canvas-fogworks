/**
 * @module index
 * @description React entry point. Mounts the App shell into #root.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<App />);
