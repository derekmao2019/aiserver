/**
 * Preserve Gemini thought signatures while translating between Gemini Parts
 * and OpenAI-compatible tool calls. Gemini requires the signature returned
 * with a function call to be sent back unchanged on the next turn.
 */

export function extractThoughtSignature(value) {
    if (!value || typeof value !== 'object') return '';
    const candidates = [
        value.thoughtSignature,
        value.thought_signature,
        value.function?.thoughtSignature,
        value.function?.thought_signature
    ];
    return candidates
        .find((candidate) => typeof candidate === 'string' && candidate.trim())
        ?.trim() || '';
}

export function buildGeminiFunctionCallPart(toolCall) {
    const fn = toolCall?.function || {};
    if (!fn.name) return null;

    const part = {
        functionCall: {
            name: fn.name,
            args: parseJsonObject(fn.arguments)
        }
    };
    const thoughtSignature = extractThoughtSignature(toolCall);
    if (thoughtSignature) part.thoughtSignature = thoughtSignature;
    return part;
}

export function buildOpenAiFunctionToolCall(part, id) {
    const call = part?.functionCall;
    if (!call?.name) return null;

    const toolCall = {
        id,
        type: 'function',
        function: {
            name: call.name,
            arguments: JSON.stringify(call.args || {})
        }
    };
    const thoughtSignature = extractThoughtSignature(part);
    if (thoughtSignature) {
        // Keep the extension in both locations. The nested location travels
        // with the OpenAI function object; the top-level copy keeps it intact
        // through gateways that rebuild function objects.
        toolCall.thought_signature = thoughtSignature;
        toolCall.function.thought_signature = thoughtSignature;
    }
    return toolCall;
}

function parseJsonObject(value) {
    if (value && typeof value === 'object') return value;
    if (!value) return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
    } catch {
        return { value };
    }
}
