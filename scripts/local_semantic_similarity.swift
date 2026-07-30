#!/usr/bin/env swift

import Foundation
import NaturalLanguage

struct SemanticDocument: Codable {
    let id: String
    let text: String
}

struct SemanticRequest: Codable {
    let query: String
    let documents: [SemanticDocument]
}

struct SemanticResult: Codable {
    let id: String
    let distance: Double
    let similarity: Double
}

struct SemanticResponse: Codable {
    let schemaVersion: String
    let engine: String
    let available: Bool
    let language: String?
    let results: [SemanticResult]
    let limitation: String?
}

func emit(_ response: SemanticResponse, exitCode: Int32 = 0) -> Never {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    do {
        let data = try encoder.encode(response)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    } catch {
        FileHandle.standardError.write(Data("\(error)\n".utf8))
        exit(2)
    }
    exit(exitCode)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let request: SemanticRequest
do {
    request = try JSONDecoder().decode(SemanticRequest.self, from: input)
} catch {
    emit(
        SemanticResponse(
            schemaVersion: "1.0",
            engine: "apple_natural_language_sentence_embedding",
            available: false,
            language: nil,
            results: [],
            limitation: "invalid_request: \(error)"
        ),
        exitCode: 2
    )
}

let recognizer = NLLanguageRecognizer()
recognizer.processString(request.query)
let detected = recognizer.dominantLanguage
let language = detected ?? .english
let embedding = NLEmbedding.sentenceEmbedding(for: language)
    ?? NLEmbedding.sentenceEmbedding(for: .english)

guard let embedding else {
    emit(
        SemanticResponse(
            schemaVersion: "1.0",
            engine: "apple_natural_language_sentence_embedding",
            available: false,
            language: language.rawValue,
            results: [],
            limitation: "sentence_embedding_unavailable"
        )
    )
}

let results = request.documents.compactMap { document -> SemanticResult? in
    let text = document.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return nil }
    let distance = embedding.distance(between: request.query, and: text)
    guard distance.isFinite else { return nil }
    let similarity = max(0.0, min(1.0, 1.0 / (1.0 + distance)))
    return SemanticResult(
        id: document.id,
        distance: distance,
        similarity: similarity
    )
}

emit(
    SemanticResponse(
        schemaVersion: "1.0",
        engine: "apple_natural_language_sentence_embedding",
        available: true,
        language: language.rawValue,
        results: results,
        limitation: nil
    )
)
