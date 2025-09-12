const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  console.log("🌐 GET / called");
  res.send("Proxy is running");
});

// Proxy endpoint
app.post("/chat/completions", async (req, res) => {
  console.log("📥 Incoming request from client:");
  console.log(JSON.stringify(req.body, null, 2));

  const body = { ...req.body, stream: false };

  if (body.stream_options) {
    console.log("❌ Stripping stream_options");
    delete body.stream_options;
  }

  try {
    console.log("📤 Sending modified request to Venice:");
    console.log(JSON.stringify(body, null, 2));

    const response = await fetch("https://api.venice.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.VENICE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();

    console.log("📬 Received response from Venice:");
    console.log(text);

    try {
      const original = JSON.parse(text);

      const cleaned = {
        id: original.id,
        object: original.object,
        created: original.created,
        model: original.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: original.choices?.[0]?.message?.content || ""
            },
            finish_reason: "stop"
          }
        ]
      };

      console.log("✅ Cleaned response to ElevenLabs:");
      console.log(JSON.stringify(cleaned, null, 2));

      res.status(200).json(cleaned);
    } catch (parseErr) {
      console.error("❌ Failed to parse Venice response:", parseErr);
      res.status(500).json({ error: "Invalid JSON from Venice" });
    }
  } catch (err) {
    console.error("❌ Proxy error:", err);
    res.status(500).json({ error: "Proxy server error" });
  }
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
