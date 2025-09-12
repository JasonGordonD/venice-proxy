const express = require("express");
const fetch = require("node-fetch");

const app = express(); // ✅ THIS LINE is crucial
app.use(express.json());

const VENICE_API_KEY = process.env.VENICE_API_KEY;

app.post("/chat/completions", async (req, res) => {
  console.log("📥 Incoming request from ElevenLabs:");
  console.log(JSON.stringify(req.body, null, 2)); // Log the incoming request for debugging

  try {
    const body = {
      ...req.body,
      stream: false // Force disable streaming
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
