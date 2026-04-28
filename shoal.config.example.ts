/**
 * shoal.config.example.ts
 *
 * Copy this file to your project directory as shoal.config.ts.
 * shoal will load it automatically — no need to fork the repo.
 *
 * Usage:
 *   cp /path/to/shoal/shoal.config.example.ts ./shoal.config.ts
 *   BASE_URL=http://localhost:3000 npm start --prefix /path/to/shoal
 */

export const target = {
  /**
   * Optional: absolute path to the project's local repository.
   * product-discovery will scan for README / docs / openapi files here
   * to give agents richer context about the app.
   *
   * If omitted but GITHUB_REPO is set in .env, the README will be fetched
   * from GitHub instead. If neither is set, discovery falls back to UI-only.
   *
   * Example:
   *   projectPath: "/Users/you/projects/my-app",
   */

  /**
   * Optional: seed credentials for the Account Manager agent.
   *
   * If set, shoal will:
   *   1. Log in as this account
   *   2. Explore user management to discover roles
   *   3. Create one test account per role found
   *   4. Run each browser agent in an authenticated session matching their role
   *
   * UX difficulties encountered during user management are recorded as findings.
   * If omitted, shoal runs without authentication.
   *
   * Example:
   *   credentials: { email: "admin@example.com", password: "yourpassword" },
   */

  /**
   * Tools the API explorer agents can call.
   * Each tool maps to one API call in execute() below.
   */
  appTools: [
    {
      name: "list_items",
      description: "Get a list of all items.",
      input_schema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: "get_item",
      description: "Get a single item by ID.",
      input_schema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Item ID" },
        },
        required: ["id"],
      },
    },
  ],

  /**
   * Called by agents when they invoke a tool.
   * toolName matches a name in appTools above.
   * Return anything JSON-serializable.
   */
  async execute(toolName: string, input: Record<string, unknown>) {
    const base = process.env.BASE_URL ?? "http://localhost:3000";

    if (toolName === "list_items") {
      const res = await fetch(`${base}/api/items`);
      return res.json();
    }

    if (toolName === "get_item") {
      const res = await fetch(`${base}/api/items/${input.id}`);
      return res.json();
    }

    throw new Error(`Unknown tool: ${toolName}`);
  },
};
