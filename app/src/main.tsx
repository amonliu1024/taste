import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// 应用内没有原生拖放：图片、链接或选区被拖起时浏览器会生成半透明拖影，一律拦掉。
document.addEventListener("dragstart", (event) => event.preventDefault());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
