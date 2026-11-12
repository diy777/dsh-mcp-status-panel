# MCP management panel

A local DeepSeek Harness bundle that adds an **MCP** entry to the Web UI sidebar.

The panel lists each configured `@deepseek-ai/dsh-mcp-client` Loader entry and shows its effective enablement, Loader phase, safe transport summary, registered tool count, and startup diagnostic. It uses the official Plugin Manager Remote to enable or disable an MCP entry.

Connection labels come from a bounded `resources/list` probe through the existing `mcpResources` provider. The probe reuses the live MCP client connection and never starts a second stdio process. A successful request is connected; a rejected or timed-out request is disconnected; non-active Loader phases remain distinct.

Sensitive `env` and `headers` values are never returned to the browser.
