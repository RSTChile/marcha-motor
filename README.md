# Marcha — Motor de decisión v0.4

Motor interno para optimización de recarga de combustible. No documentar públicamente.

## Uso

```javascript
const { decide } = require('./src/engine');

const result = decide(userProfile, stations, context);
// { mode, recommendation, alternative, message }