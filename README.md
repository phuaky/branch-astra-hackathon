# Branch

Branch turns a sales conversation into a map you can explore. Inspect the next question, revisit an earlier exchange, and practise another response while keeping the original conversation intact.

Built for the GPT-6 Astra Hackathon in Singapore, 13 September 2026. Team: soil-rose, Vi + Kuan Yu.

## Try the demo

The hosted demo connects to Astra and GPT-Live-1 through its server. The API key stays in the hosting service's secret store. The opening sample uses labelled local preview rules. New exchanges use AI when the connection is available.

1. Press Play or Next exchange.
2. Select a moment to inspect its transcript.
3. Open Coach & evidence to see possible questions and source passages.
4. Open Review and select Practise from this moment.
5. Enter another response. Return to original to restore the first attempt.

The demo opens in the 3D map. Select Simple view or use `?view=simple` for a topic list. Import [the fictional 48-turn call](docs/mock-sales-call.txt) to explore a longer conversation.

## Run locally

Install Bun, then run:

```sh
bun install
bun run dev
```

Open `http://127.0.0.1:5180/?view=map`. The API listens on `127.0.0.1:5181`.

To connect Astra and GPT-Live-1, copy `.env.example` to `.env.local`. Set `OPENAI_API_KEY` to a key with access to the required models. Keep the key on the server. The project reads only its local file and does not use an ambient shell key. No key is required for preview mode.

## How Astra is used

GPT-6 Astra maps completed transcript turns to topics through the Responses API. A separate request produces suggested questions, source references, and coaching feedback. The map can update while coaching is pending.

Each request receives only the conversation through the current moment. Structured results must pass validation before they change the scene. Seeking or starting a retry invalidates old responses. Existing topic identities and positions remain stable.

GPT-Live-1 transcribes browser microphone input. Fresh speech enters the same conversation state as replay. The practice integration also requests a simulated customer, but the latest recorded practice test did not produce a customer reply. Spoken user input did create a separate practice path.

This implementation uses the Responses API and Live API. It does not claim use of the Agents API.

## Data handling

Imported transcripts remain in browser memory. With AI connected, reviewed transcript text is sent for analysis. Selected-name replacements apply to the working copy and exports. Other business details remain unchanged. Live audio is sent to the voice provider before display masking.

The bundled call is fictional. The bundled evidence passage describes an internal reliability trial; it is not a customer success story. This repository excludes private evaluation transcripts, reversible name maps, credentials, and unreviewed recordings.

## Validation

```sh
bun test
bun run build
bun run verify -- help
```

Some original verification probes require a withheld 206-turn transcript. Set `BRANCH_VERIFY_TRANSCRIPT` to an authorized local copy to run those probes. The public test suite skips the four source-dependent probes when that file is absent. It does not substitute fictional input and report the private-source checks as passed.

Recorded development checks established real Astra coaching and a 120-second GPT-Live-1 microphone run with 20 finalized human utterances. These results do not guarantee sales outcomes or general model accuracy. The final spoken customer reply and full submission video were still being completed when this snapshot was prepared.

## Stack

TypeScript, React, Three.js, Vite, Bun, and the OpenAI SDK. The browser contains the map, transcript, review, and practice state. The local Bun server and hosted Worker handle model requests and credentials. Set the hosted `OPENAI_API_KEY` as a Sites secret and deploy to apply a key change.
