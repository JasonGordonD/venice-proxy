const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  console.log("🌐 GET / called");
  res.send("Proxy is running");
});

app.post("/chat/completions", async (req, res) => {
  console.log("📥 Incoming request from client:");
  console.log(JSON.stringify(req.body, null, 2));

  const body = JSON.parse(JSON.stringify(req.body));
  body.stream = false;
  if (body.stream_options) {
    console.log("❌ Stripping stream_options (not allowed when stream = false)");
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
      const json = JSON.parse(text);

      // ✅ Clean Venice's response before sending it to ElevenLabs
      if (json.choices?.[0]?.message) {
        const msg = json.choices[0].message;
        delete msg.refusal;
        delete msg.annotations;
        delete msg.audio;
        delete msg.function_call;
        delete msg.tool_calls;
        delete msg.reasoning_content;
      }

      delete json.venice_parameters;

      console.log("✅ Cleaned response to ElevenLabs:");
      console.log(JSON.stringify(json, null, 2));

      res.status(response.status).json(json);
    } catch (err) {
      console.error("❌ JSON parse error:", err);
      res.status(500).json({ error: "Invalid JSON response from Venice" });
    }
  } catch (err) {
    console.error("❌ Proxy error:", err);
    res.status(500).json({ error: "Proxy server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
