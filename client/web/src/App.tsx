import { McpPage } from "./mcp/McpPage";

export function App() {
  if (location.pathname === "/mcp" || location.pathname === "/mcp/") return <McpPage />;
  return <main>lulu</main>;
}
