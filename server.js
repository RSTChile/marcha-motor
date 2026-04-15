const express = require("express");
const path = require("path");

const { runPipeline } = require("./src/pipeline");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 🔥 ENDPOINT PRINCIPAL
app.post("/api/decide", async (req, res) => {
  try {
    const { userProfile, context } = req.body;

    if (!userProfile || !context) {
      return res.status(400).json({
        error: "Faltan userProfile o context",
      });
    }

    const result = await runPipeline({
      userProfile,
      context,
    });

    res.json(result);
  } catch (err) {
    console.error("Error en /api/decide:", err);
    res.status(500).json({
      error: "Error interno",
    });
  }
});

// Health check (clave para Render)
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// SPA fallback (para tu index.html)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Marcha corriendo en puerto ${PORT}`);
});