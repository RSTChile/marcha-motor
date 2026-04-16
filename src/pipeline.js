const engine = require('./engine');

async function runPipeline({ userProfile, context }) {
  return {
    mode: 1,
    recommendation: null,
    alternatives: [],
    message: "Pipeline limpio funcionando"
  };
}

module.exports = { runPipeline };
