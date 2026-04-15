const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== IMPORTS (corregido: usa getDecision, no runPipeline) =====
let getDecision;
try {
  ({ getDecision } = require("./src/pipeline"));
} catch (e) {
  console.error("Error cargando pipeline:", e.message);
}

// ===== MIDDLEWARE =====
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== HEALTH CHECK =====
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ===== API =====
app.post("/api/decide", async (req, res) => {
  try {
    if (!getDecision) {
      return res.status(500).json({
        error: "Pipeline no disponible",
      });
    }

    const { userProfile, context } = req.body;

    if (!userProfile || !context) {
      return res.status(400).json({
        error: "Faltan userProfile o context",
      });
    }

    const result = await getDecision(userProfile, context);
    res.json(result);
  } catch (err) {
    console.error("ERROR /api/decide:", err);
    res.status(500).json({
      error: "Error interno",
    });
  }
});

// ===== FALLBACK FRONTEND =====
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`🚀 Marcha activo en puerto ${PORT}`);
});