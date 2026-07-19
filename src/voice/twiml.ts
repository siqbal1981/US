// TwiML builders (SPEC.md §7).
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildConnectRelayTwiml(publicHost: string, greeting: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="wss://${publicHost}/voice/relay" welcomeGreeting="${escapeXml(greeting)}" />
  </Connect>
</Response>`;
}

export function buildRejectTwiml(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${escapeXml(message)}</Say>
  <Hangup/>
</Response>`;
}
