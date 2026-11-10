export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      return Response.json({ status: "ok", service: "agent-commons" });
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler;
