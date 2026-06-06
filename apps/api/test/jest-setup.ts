// Runs before any module import: the e2e suite legitimately exceeds the human-scale
// rate limits, so raise them for tests only. Production defaults stay in the controllers.
process.env.UPLOAD_THROTTLE_LIMIT = '1000';
process.env.RENDER_THROTTLE_LIMIT = '1000';
