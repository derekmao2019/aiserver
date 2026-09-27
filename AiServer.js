import 'dotenv/config'; 
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = 4000;
const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || 'v1beta';
const DEFAULT_MODELS = [
    'gemini-1.5-flash',
    'gemini-1.5-pro',
    'gemini-2.0-flash',
    'gemini-2.5-flash',
    'gemini-2.5-pro'
];
// OpenAI-compatible requests can contain multi-round tool results and tool definitions.
// Express's 100kb default is too small for Datawaves intelligent data analyst requests.
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '10mb';

app.use(cors());
app.use(express.json({ limit: JSON_BODY_LIMIT }));

/**
 * 简易鉴权中间件
 */
const verifyToken = (req, res, next) => {
    const secret = process.env.INTERNAL_SERVICE_SECRET;
    if (secret) {
        const token = req.headers['authorization'];
        if (token !== `Bearer ${secret}`) {
            return res.status(403).json({ error: 'Unauthorized: Invalid Bearer token' });
        }
    }
    next();
};

const getConfiguredModels = () => {
    const models = (process.env.AI_MODELS || '')
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean);
    return models;
};

const getApiKey = () => process.env.API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;

const getFallbackModels = (primaryModel) => {
    const configured = (process.env.AI_FALLBACK_MODELS || '')
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean);
    return configured.filter((model) => model !== primaryModel);
};

const fetchGeminiModels = async () => {
    const apiKey = getApiKey();
    if (!apiKey) {
        const err = new Error('Server Misconfigured: API Key missing');
        err.status = 500;
        throw err;
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
    const data = await response.json().catch(() => null);
    if (!response.ok) {
        const err = new Error(data?.error?.message || data?.message || 'Failed to fetch Gemini models');
        err.status = response.status;
        throw err;
    }

    return [...new Set((data?.models || [])
        .filter((model) => Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent'))
        .map((model) => String(model.name || '').replace(/^models\//, '').trim())
        .filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
};

const getAvailableModels = async () => {
    const configuredModels = getConfiguredModels();
    if (configuredModels.length > 0) {
        return { models: configuredModels, source: 'env' };
    }

    try {
        const models = await fetchGeminiModels();
        return { models: models.length > 0 ? models : DEFAULT_MODELS, source: models.length > 0 ? 'gemini' : 'fallback' };
    } catch (error) {
        console.warn('[Models] Failed to fetch Gemini model list, using fallback:', error.message);
        return { models: DEFAULT_MODELS, source: 'fallback', warning: error.message };
    }
};

app.get('/api/models', verifyToken, async (req, res) => {
    const result = await getAvailableModels();
    res.json(result);
});

app.get('/v1/models', verifyToken, async (req, res) => {
    const { models, source, warning } = await getAvailableModels();
    res.json({
        object: 'list',
        data: models.map((model) => ({
            id: model,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'google'
        })),
        source,
        ...(warning ? { warning } : {})
    });
});

/**
 * OpenAI compatible chat completions endpoint.
 * Datawaves should call this endpoint directly with messages/tools and let AiServer
 * own the Gemini-specific conversion.
 */
app.post('/v1/chat/completions', verifyToken, async (req, res) => {
    const apiKey = getApiKey();
    if (!apiKey) {
        return res.status(500).json({ error: { message: 'Server Misconfigured: API Key missing', type: 'server_error' } });
    }

    const { model, stream, ...payload } = req.body || {};
    if (stream) {
        return res.status(400).json({ error: { message: 'Streaming is not supported by this AiServer endpoint', type: 'invalid_request_error' } });
    }

    try {
        const modelName = model || 'gemini-1.5-flash';
        const requestPayload = toGeminiGeneratePayload(payload);

        console.log(`[OpenAI Compat Request] Time: ${new Date().toLocaleTimeString()} | Model: ${modelName}`);

        const response = await generateWithFallback(apiKey, modelName, requestPayload);
        const usage = response.usageMetadata;
        if (usage) {
            console.log(`[Usage] Prompt: ${usage.promptTokenCount} | Output: ${usage.candidatesTokenCount} | Total: ${usage.totalTokenCount}`);
        }

        res.json(fromGeminiGenerateResponse(response, modelName));
    } catch (error) {
        console.error('OpenAI Compat Proxy Error:', {
            message: error.message,
            status: error.status,
            details: error.details
        });
        res.status(error.status || 500).json({
            error: {
                message: error.message || 'AI Generation Failed',
                type: 'upstream_error',
                upstream: error.details
            }
        });
    }
});

/**
 * AI 转发核心接口
 * 支持透传 contents, tools 和 system_instruction 以适配 Agent 模式
 */
app.post('/api/generate', verifyToken, async (req, res) => {
    // 解析 Datawaves 发来的完整载荷
    const { 
        contents,           // 包含对话历史的数组
        tools,              // 工具/函数定义
        system_instruction, // 系统角色指令
        prompt,             // 兼容老版本的单次提问
        model 
    } = req.body;
    
    const apiKey = getApiKey();
    if (!apiKey) {
        return res.status(500).json({ error: 'Server Misconfigured: API Key missing' });
    }

    try {
        const modelName = model || 'gemini-1.5-flash';

        // 构造请求内容：优先使用 Agent 模式的 contents 数组
        const requestPayload = {
            contents: contents || [{ role: 'user', parts: [{ text: prompt }] }],
            tools: tools, // 关键：转发工具定义，允许 AI 决定是否调用数据库
            systemInstruction: system_instruction ? { parts: [{ text: system_instruction }] } : undefined
        };

        console.log(`[AI Request] Time: ${new Date().toLocaleTimeString()} | Model: ${modelName}`);

        const response = await generateWithFallback(apiKey, modelName, requestPayload);
        
        // 打印 Token 使用量监控
        const usage = response.usageMetadata;
        if (usage) {
            console.log(`[Usage] Prompt: ${usage.promptTokenCount} | Output: ${usage.candidatesTokenCount} | Total: ${usage.totalTokenCount}`);
        }

        /**
         * 关键：透传整个 response 对象
         * 这样 Datawaves 后端就能收到包含 functionCalls 的结构，
         * 从而触发真正的数据库查询操作。
         */
        res.json(response);

    } catch (error) {
        console.error('AI Proxy Error:', {
            message: error.message,
            status: error.status,
            details: error.details
        });
        res.status(error.status || 500).json({
            error: 'AI Generation Failed', 
            details: error.message,
            upstream: error.details
        });
    }
});

async function generateWithFallback(apiKey, primaryModel, requestPayload) {
    const models = [primaryModel, ...getFallbackModels(primaryModel)];
    let lastError = null;

    for (const candidateModel of models) {
        try {
            if (candidateModel !== primaryModel) {
                console.warn(`[AI Fallback] Retrying with ${candidateModel} after ${lastError?.message || 'unknown error'}`);
            }
            const response = await callGeminiGenerateContent(apiKey, candidateModel, requestPayload);
            return { ...response, model: candidateModel };
        } catch (error) {
            lastError = error;
            if (!shouldTryFallback(error)) break;
        }
    }

    throw lastError || new Error('AI Generation Failed');
}

function shouldTryFallback(error) {
    const status = Number(error?.status || 0);
    return status === 0 || status === 404 || status === 429 || status >= 500;
}

async function callGeminiGenerateContent(apiKey, modelName, requestPayload) {
    const cleanPayload = removeUndefined(requestPayload);
    const encodedModel = encodeURIComponent(modelName);
    const url = `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${encodedModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cleanPayload)
    });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
        const err = new Error(data?.error?.message || data?.message || `Gemini API request failed with ${response.status}`);
        err.status = response.status;
        err.details = data;
        throw err;
    }

    return data;
}

function removeUndefined(value) {
    if (Array.isArray(value)) {
        return value.map(removeUndefined);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, entryValue]) => entryValue !== undefined)
                .map(([key, entryValue]) => [key, removeUndefined(entryValue)])
        );
    }
    return value;
}

function toGeminiGeneratePayload(payload = {}) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const systemMessages = messages
        .filter((message) => message?.role === 'system')
        .map((message) => normalizeMessageContent(message.content))
        .filter(Boolean);
    const contents = messages
        .filter((message) => message?.role !== 'system')
        .map(toGeminiContent)
        .filter(Boolean);
    const generationConfig = {};

    if (payload.temperature !== undefined) generationConfig.temperature = Number(payload.temperature);
    if (payload.max_tokens !== undefined) generationConfig.maxOutputTokens = Number(payload.max_tokens);
    if (payload.max_completion_tokens !== undefined) generationConfig.maxOutputTokens = Number(payload.max_completion_tokens);

    return {
        systemInstruction: systemMessages.length > 0 ? { parts: [{ text: systemMessages.join('\n\n') }] } : undefined,
        contents: contents.length > 0 ? contents : undefined,
        tools: toGeminiTools(payload.tools),
        generationConfig: Object.keys(generationConfig).length > 0 ? generationConfig : undefined
    };
}

function toGeminiContent(message) {
    if (!message?.role) return null;

    if (message.role === 'tool') {
        return {
            role: 'user',
            parts: [{
                functionResponse: {
                    name: message.name || 'tool_result',
                    response: parseJsonObject(message.content)
                }
            }]
        };
    }

    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    const text = normalizeMessageContent(message.content);
    if (text) parts.push({ text });

    if (Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
            const name = toolCall?.function?.name;
            if (!name) continue;
            parts.push({
                functionCall: {
                    name,
                    args: parseJsonObject(toolCall.function?.arguments)
                }
            });
        }
    }

    if (parts.length === 0) return null;
    return { role, parts };
}

function toGeminiTools(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return undefined;
    const functionDeclarations = tools
        .map((tool) => tool?.function)
        .filter((fn) => fn?.name)
        .map((fn) => ({
            name: fn.name,
            description: fn.description || '',
            parameters: fn.parameters || { type: 'object', properties: {} }
        }));

    return functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined;
}

function fromGeminiGenerateResponse(data, requestedModel) {
    const candidate = data?.candidates?.[0] || {};
    const parts = candidate?.content?.parts || [];
    const text = parts
        .map((part) => part?.text)
        .filter(Boolean)
        .join('');
    const toolCalls = parts
        .map((part, index) => {
            const call = part?.functionCall;
            if (!call?.name) return null;
            return {
                id: `call_${Date.now()}_${index}`,
                type: 'function',
                function: {
                    name: call.name,
                    arguments: JSON.stringify(call.args || {})
                }
            };
        })
        .filter(Boolean);

    return {
        id: `chatcmpl_${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: data?.model || requestedModel,
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: text,
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
            },
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : normalizeFinishReason(candidate.finishReason)
        }],
        ...(data?.usageMetadata ? { usage: fromGeminiUsage(data.usageMetadata) } : {})
    };
}

function fromGeminiUsage(usage) {
    return {
        prompt_tokens: usage.promptTokenCount || 0,
        completion_tokens: usage.candidatesTokenCount || 0,
        total_tokens: usage.totalTokenCount || ((usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0))
    };
}

function normalizeFinishReason(reason) {
    if (reason === 'MAX_TOKENS') return 'length';
    if (reason === 'STOP') return 'stop';
    return reason ? String(reason).toLowerCase() : 'stop';
}

function normalizeMessageContent(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => typeof part === 'string' ? part : (part?.text || ''))
            .filter(Boolean)
            .join('\n');
    }
    return String(content);
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`------------------------------------------------`);
    console.log(`🚀 Datawaves AI Proxy Server 启动成功`);
    console.log(`端口: ${PORT}`);
    console.log(`状态: 等待 Agent 请求...`);
    console.log(`------------------------------------------------`);
});
