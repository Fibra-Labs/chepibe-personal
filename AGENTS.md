# AGENTS.md

## Privacy-First Logging Policy

This project is privacy-first. **Never log user messages, transcripts, or summaries.** Only the minimum amount of information required to provide the service may be retained or logged.

When writing code:
- Never log audio content, transcription text, or summary text
- Never log WhatsApp message bodies
- Never log full API request/response payloads containing user data
- Only log metadata (message IDs, timestamps, buffer sizes, transcription lengths, error codes) — never the content itself
- The Groq SDK debug logger (which dumps full request/response bodies including transcription text and API keys) must always be suppressed regardless of the `DEBUG` env var
- Any `DEBUG` logging must be limited to connection state and infrastructure events — never user-facing data