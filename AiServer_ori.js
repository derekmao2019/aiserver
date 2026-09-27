import 'dotenv/config'; // Load environment variables from .env file
import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = 4000;

app.use(cors());
app.use(express.json());

// Authentication Middleware
const verifyToken = (req, res, next) => {
    const secret = process.env.INTERNAL_SERVICE_SECRET;
    // If no secret is configured, we can opt to allow open access or block. 
    // For safety, we block unless specifically intended, but for this skeleton we'll allow if secret is missing 
    // to prevent immediate lockout during dev, or you can strictly enforce it.
    // Here we strictly enforce it ONLY if the env var is set.
    if (secret) {
        const token = req.headers['authorization'];
        if (token !== `Bearer ${secret}`) {
            return res.status(403).json({ error: 'Unauthorized: Invalid Bearer token' });
        }
    }
    next();
};

app.post('/api/generate', verifyToken, async (req, res) => {
    const { prompt, model } = req.body;
    
    // CRITICAL: The API key must be obtained exclusively from process.env.API_KEY
    const apiKey = process.env.API_KEY;
    
    if (!apiKey) {
        console.error("Critical Error: process.env.API_KEY is missing.");
        return res.status(500).json({ error: 'Server Misconfigured: API Key missing' });
    }

    if (!prompt) {
        return res.status(400).json({ error: 'Bad Request: "prompt" field is required.' });
    }

    try {
        const ai = new GoogleGenAI({ apiKey });
        
        // Use the model specified in the request or default to Flash
        const modelName = model || 'gemini-2.5-flash';
        
        const response = await ai.models.generateContent({
            model: modelName,
            contents: prompt,
        });

        // Extract usage metadata
        const usage = response.usageMetadata;
        const timestamp = new Date().toISOString();

        // Log token usage to console
        if (usage) {
            console.log(`[${timestamp}] Token Usage - Model: ${modelName} | Prompt: ${usage.promptTokenCount} | Output: ${usage.candidatesTokenCount} | Total: ${usage.totalTokenCount}`);
        } else {
            console.log(`[${timestamp}] Token Usage - Model: ${modelName} | Usage metadata unavailable`);
        }

        // Directly access the .text property
        res.json({ 
            text: response.text,
            model: modelName,
            usageMetadata: usage
        });

    } catch (error) {
        console.error("AI Service Error:", error);
        res.status(500).json({ 
            error: 'AI Generation Failed', 
            details: error instanceof Error ? error.message : String(error) 
        });
    }
});

app.listen(PORT, () => {
    console.log(`Backend AI Service running on port ${PORT}`);
    console.log(`Endpoint: http://localhost:${PORT}/api/generate`);
});

