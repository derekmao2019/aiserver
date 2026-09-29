import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildGeminiFunctionCallPart,
    buildOpenAiFunctionToolCall
} from '../geminiCompat.js';

test('round trips Gemini function call thought signatures', () => {
    const geminiPart = {
        functionCall: {
            name: 'default_api:mcp_purchase_request_list',
            args: { page: 1 }
        },
        thoughtSignature: 'signature-from-gemini'
    };

    const openAiToolCall = buildOpenAiFunctionToolCall(geminiPart, 'call_1');
    assert.equal(openAiToolCall.function.thought_signature, 'signature-from-gemini');
    assert.equal(openAiToolCall.thought_signature, 'signature-from-gemini');

    const replayedPart = buildGeminiFunctionCallPart(openAiToolCall);
    assert.deepEqual(replayedPart, geminiPart);
});

test('keeps function calls without a thought signature compatible', () => {
    const toolCall = {
        id: 'call_2',
        type: 'function',
        function: {
            name: 'mcp_purchase_request_list',
            arguments: '{"page":2}'
        }
    };

    assert.deepEqual(buildGeminiFunctionCallPart(toolCall), {
        functionCall: {
            name: 'mcp_purchase_request_list',
            args: { page: 2 }
        }
    });
});
