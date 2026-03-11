use crate::audio_toolkit::load_audio_file;
use crate::managers::history::HistoryManager;
use crate::managers::transcription::TranscriptionManager;
use crate::settings::{get_settings, write_settings, ModelUnloadTimeout};
use log::{debug, error, info};
use serde::Serialize;
use specta::Type;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize, Type)]
pub struct ModelLoadStatus {
    is_loaded: bool,
    current_model: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub fn set_model_unload_timeout(app: AppHandle, timeout: ModelUnloadTimeout) {
    let mut settings = get_settings(&app);
    settings.model_unload_timeout = timeout;
    write_settings(&app, settings);
}

#[tauri::command]
#[specta::specta]
pub fn get_model_load_status(
    transcription_manager: State<TranscriptionManager>,
) -> Result<ModelLoadStatus, String> {
    Ok(ModelLoadStatus {
        is_loaded: transcription_manager.is_model_loaded(),
        current_model: transcription_manager.get_current_model(),
    })
}

#[tauri::command]
#[specta::specta]
pub fn unload_model_manually(
    transcription_manager: State<TranscriptionManager>,
) -> Result<(), String> {
    transcription_manager
        .unload_model()
        .map_err(|e| format!("Failed to unload model: {}", e))
}

#[derive(Serialize, Type)]
pub struct FileTranscriptionResult {
    pub text: String,
    pub file_name: String,
}

#[tauri::command]
#[specta::specta]
pub async fn transcribe_audio_file(
    app: AppHandle,
    file_path: String,
    transcription_manager: State<'_, Arc<TranscriptionManager>>,
    history_manager: State<'_, Arc<HistoryManager>>,
) -> Result<FileTranscriptionResult, String> {
    info!("Transcribing audio file: {}", file_path);

    // Emit progress event
    let _ = app.emit("file-transcription-progress", "loading");

    // Load and decode the audio file
    let audio_samples = load_audio_file(&file_path)
        .map_err(|e| format!("Failed to load audio file: {}", e))?;

    if audio_samples.is_empty() {
        return Err("Audio file is empty or could not be decoded".to_string());
    }

    info!("Loaded {} audio samples from file", audio_samples.len());

    // Ensure model is loaded
    if !transcription_manager.is_model_loaded() {
        let _ = app.emit("file-transcription-progress", "loading_model");
        let settings = get_settings(&app);
        transcription_manager
            .load_model(&settings.selected_model)
            .map_err(|e| format!("Failed to load model: {}", e))?;
    }

    let _ = app.emit("file-transcription-progress", "transcribing");

    // Transcribe
    let text = transcription_manager
        .transcribe(audio_samples.clone())
        .map_err(|e| {
            error!("File transcription failed: {}", e);
            format!("Transcription failed: {}", e)
        })?;

    // Get the file name for display
    let file_name = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("audio_file")
        .to_string();

    // Save to history
    if let Err(e) = history_manager
        .save_transcription(audio_samples, text.clone(), None, None)
        .await
    {
        error!("Failed to save file transcription to history: {}", e);
    }

    let _ = app.emit("file-transcription-progress", "done");

    info!("File transcription complete: {}", file_name);

    Ok(FileTranscriptionResult { text, file_name })
}

/// Split text into chunks of approximately `max_words` words, splitting at sentence boundaries.
fn chunk_text(text: &str, max_words: usize) -> Vec<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() <= max_words {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut current_chunk = String::new();
    let mut word_count = 0;

    for word in &words {
        if word_count >= max_words {
            // Try to split at sentence boundary
            if let Some(pos) = current_chunk.rfind(|c| c == '.' || c == '!' || c == '?' || c == '،' || c == '。') {
                let (sentence_end, remainder) = current_chunk.split_at(pos + 1);
                chunks.push(sentence_end.trim().to_string());
                current_chunk = remainder.trim().to_string();
                word_count = current_chunk.split_whitespace().count();
            } else {
                chunks.push(current_chunk.trim().to_string());
                current_chunk = String::new();
                word_count = 0;
            }
        }

        if !current_chunk.is_empty() {
            current_chunk.push(' ');
        }
        current_chunk.push_str(word);
        word_count += 1;
    }

    if !current_chunk.trim().is_empty() {
        chunks.push(current_chunk.trim().to_string());
    }

    chunks
}

const FORMAT_SYSTEM_PROMPT: &str = r#"You are a text formatting assistant. Your ONLY job is to add punctuation and organize the text into paragraphs. Rules:
- Add appropriate punctuation (periods, commas, question marks, etc.)
- Split the text into logical paragraphs with blank lines between them
- Do NOT change any words, do NOT translate, do NOT summarize
- Do NOT add or remove any content
- Preserve the original language exactly
- Return ONLY the formatted text, nothing else"#;

#[tauri::command]
#[specta::specta]
pub async fn format_transcription_text(
    app: AppHandle,
    text: String,
) -> Result<String, String> {
    info!("Formatting transcription text ({} chars)", text.len());

    let settings = get_settings(&app);

    let provider = settings
        .active_post_process_provider()
        .cloned()
        .ok_or_else(|| "No post-processing provider configured. Please set up a provider in the Post Processing settings.".to_string())?;

    let model = settings
        .post_process_models
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    if model.trim().is_empty() {
        return Err(format!(
            "No model configured for provider '{}'. Please select a model in Post Processing settings.",
            provider.label
        ));
    }

    let api_key = settings
        .post_process_api_keys
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    // Chunk the text for long transcriptions (~3000 words per chunk)
    let chunks = chunk_text(&text, 3000);
    let total_chunks = chunks.len();

    debug!("Split text into {} chunk(s) for formatting", total_chunks);

    let mut formatted_parts = Vec::new();

    for (i, chunk) in chunks.iter().enumerate() {
        debug!("Processing chunk {}/{} ({} chars)", i + 1, total_chunks, chunk.len());

        let _ = app.emit("format-text-progress", format!("{}/{}", i + 1, total_chunks));

        let result = crate::llm_client::send_chat_completion_with_schema(
            &provider,
            api_key.clone(),
            &model,
            chunk.clone(),
            Some(FORMAT_SYSTEM_PROMPT.to_string()),
            None, // No JSON schema - we want plain text back
        )
        .await
        .map_err(|e| format!("LLM request failed: {}", e))?;

        match result {
            Some(content) => formatted_parts.push(content),
            None => {
                return Err("LLM returned empty response".to_string());
            }
        }
    }

    let formatted = formatted_parts.join("\n\n");
    info!("Text formatting complete ({} chars → {} chars)", text.len(), formatted.len());

    Ok(formatted)
}
