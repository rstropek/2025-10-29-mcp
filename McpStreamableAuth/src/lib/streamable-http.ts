import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import cors from 'cors';

/**
 * Creates and starts a streamable HTTP server for MCP (Model Context Protocol) communication.
 *
 * This function sets up a complete HTTP server that handles MCP protocol communication
 * using the Streamable HTTP transport. It provides session management, automatic transport
 * cleanup, and health monitoring capabilities.
 *
 * HTTP Endpoints:
 * - POST /mcp - Main JSON-RPC endpoint for MCP protocol communication
 * - GET /mcp - Server-to-client notifications via Server-Sent Events (SSE)
 * - DELETE /mcp - Session termination endpoint
 * - GET /health - Health check endpoint with server status and active session count
 *
 * @param server - The MCP server instance to wrap with HTTP transport
 * @param serverName - Human-readable name for the server (used in logs and health checks)
 * @param serverVersion - Version string for the server (used in logs and health checks)
 * @param port - Default port number for the server (can be overridden by PORT environment variable)
 */
export function createStreamableHTTPServer(server: McpServer, serverName: string, serverVersion: string, port: number): void {
  // Initialize Express application for HTTP server
  const app = express();

  app.use((req, res, next) => {
    console.log('Request received:', req.method, req.url);
    next();
  });

  /**
   * CORS (Cross-Origin Resource Sharing) configuration for the MCP server.
   * 
   * This permissive configuration allows requests from any origin, which is necessary
   * for MCP clients running in different contexts (browsers, desktop apps, CLI tools).
   * 
   * Configuration options explained:
   * 
   * - origin: Dynamic origin validation function
   *   - Accepts ALL origins by calling callback with (null, true)
   *   - This is necessary because MCP clients may run from various domains/contexts
   *   - In production, you might want to restrict this to specific trusted origins
   * 
   * - credentials: Set to false for security
   *   - Disables sending cookies and HTTP authentication in cross-origin requests
   *   - We use OAuth 2.0 Bearer tokens in Authorization header instead of cookies
   *   - This prevents CSRF (Cross-Site Request Forgery) attacks
   * 
   * - methods: ['GET', 'POST', 'OPTIONS']
   *   - GET: Used for SSE (Server-Sent Events) notifications and health checks
   *   - POST: Used for main MCP JSON-RPC requests
   *   - OPTIONS: Pre-flight requests that browsers send before actual requests
   * 
   * - allowedHeaders: Headers that clients are allowed to send
   *   - 'Mcp-Protocol-Version': MCP protocol version identifier
   *   - 'Content-Type': Required for JSON request bodies
   *   - 'Authorization': OAuth 2.0 Bearer token for authentication
   *   - 'Mcp-Session-Id': Session identifier for maintaining MCP sessions across requests
   * 
   * - exposedHeaders: Headers that browsers can access in the response
   *   - 'WWW-Authenticate': OAuth challenge information when authentication fails
   *   - 'Mcp-Session-Id': Session identifier returned after initialization
   *   - Browsers need explicit permission to read these security-related headers
   * 
   * - maxAge: 86400 seconds (24 hours)
   *   - How long browsers can cache the pre-flight OPTIONS response
   *   - Reduces the number of OPTIONS requests for better performance
   *   - Browsers won't send another OPTIONS request for 24 hours
   */
  const allowAll = cors({
    origin: (origin, cb) => cb(null, true),
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Mcp-Protocol-Version', 'Content-Type', 'Authorization', 'Mcp-Session-Id'],
    exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'],
    maxAge: 86400,
  });
  app.options(/.*/, allowAll); // Technically not needed, but good practice to 
  // explicitly support OPTIONS requests for all routes.
  app.use(allowAll);

  // Configure Express to parse JSON request bodies automatically
  app.use(express.json());

  // Map to store active transports by session ID for session management
  // This allows the server to reuse existing transports for ongoing sessions
  const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  // Health check endpoint (registered before auth middleware so it remains public)
  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      activeSessions: Object.keys(transports).length,
      serverName: serverName,
      serverVersion: serverVersion,
    });
  });

  /**
   * Main MCP endpoint handler for JSON-RPC requests.
   * Handles session management and routes requests to appropriate transports.
   */
  app.post('/mcp', async (req, res) => {
    // Extract session ID from request headers (if present)
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport for ongoing session
      transport = transports[sessionId];
    } else if (!sessionId && req.body && req.body.method === 'initialize') {
      // Create new transport for initial connection (initialize request)
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          // Store the transport for future reuse
          transports[sessionId] = transport;

          // Set the session ID in response header so client knows what to use
          res.setHeader('mcp-session-id', sessionId);
        },
      });

      // Clean up transport when session closes to prevent memory leaks
      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
        }
      };

      // Connect the MCP server to the new transport
      server.connect(transport);
    } else {
      // Invalid request - no session ID provided for non-initialize requests
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  /**
   * Reusable handler for GET and DELETE requests that require session validation.
   * Used for Server-Sent Events (SSE) notifications and session termination.
   */
  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    // Validate session ID exists and transport is available
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    // Get the existing transport and delegate request handling within auth context
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  };

  // Handle GET requests for server-to-client notifications via SSE
  app.get('/mcp', handleSessionRequest);
  // Handle DELETE requests for session termination
  app.delete('/mcp', handleSessionRequest);

  const PORT = process.env.PORT || port;
  app.listen(PORT, () => {
    console.log(`MCP server (${serverName}) running at http://127.0.0.1:${PORT}/mcp`);
    console.log(`Health check: http://127.0.0.1:${PORT}/health`);
  });
}
