import { render } from "preact";
import { App } from "./App";
import { initTheme } from "./theme/themeStore";
import "./styles.css";

initTheme();

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
}
