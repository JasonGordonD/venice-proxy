app.post("/chat/completions", async (req, res) => {
  console.log("📥 Incoming request from ElevenLabs:");
  console.log(JSON.stringify(req.body, null, 2));  // Logs request body
  try {
    const body = {
      ...req.body,
      stream: false  // force disable streaming
    };

    const veniceRes = await fetch("https://api.venice.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${VENICE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const json = await veniceRes.json();
    res.status(veniceRes.status).json(json);
  } catch (err) {
    console.error("❌ Proxy error:", err);
    res.status(500).json({ error: "Proxy server error" });
  }
});
