#!/usr/bin/env swift

import CoreGraphics
import Foundation
import ImageIO
import Vision

struct NormalizedRect: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct FaceResult: Codable {
    let confidence: Float
    let bounds: NormalizedRect
    let topMargin: Double
}

struct HumanResult: Codable {
    let confidence: Float
    let bounds: NormalizedRect
}

struct TextResult: Codable {
    let text: String
    let confidence: Float
    let bounds: NormalizedRect
}

struct ClassificationResult: Codable {
    let identifier: String
    let confidence: Float
}

struct FrameResult: Codable {
    let path: String
    let width: Int
    let height: Int
    let faces: [FaceResult]
    let humans: [HumanResult]
    let recognizedText: [TextResult]
    let classifications: [ClassificationResult]
    let status: String
    let error: String?
}

func topLeftRect(_ rect: CGRect) -> NormalizedRect {
    NormalizedRect(
        x: rect.origin.x,
        y: 1.0 - rect.origin.y - rect.size.height,
        width: rect.size.width,
        height: rect.size.height
    )
}

func loadImage(_ file: String) -> CGImage? {
    let url = URL(fileURLWithPath: file) as CFURL
    guard let source = CGImageSourceCreateWithURL(url, nil) else {
        return nil
    }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

let files = Array(CommandLine.arguments.dropFirst())
if files.isEmpty {
    FileHandle.standardError.write(
        Data("Usage: analyze_visual_frames.swift IMAGE [IMAGE ...]\n".utf8)
    )
    exit(2)
}

var output: [FrameResult] = []
for file in files {
    guard let image = loadImage(file) else {
        output.append(
            FrameResult(
                path: file,
                width: 0,
                height: 0,
                faces: [],
                humans: [],
                recognizedText: [],
                classifications: [],
                status: "fail",
                error: "could not decode image"
            )
        )
        continue
    }

    let faceRequest = VNDetectFaceRectanglesRequest()
    let humanRequest = VNDetectHumanRectanglesRequest()
    humanRequest.upperBodyOnly = false
    let textRequest = VNRecognizeTextRequest()
    textRequest.recognitionLevel = .accurate
    textRequest.usesLanguageCorrection = true
    textRequest.minimumTextHeight = 0.012
    let classificationRequest = VNClassifyImageRequest()

    do {
        let handler = VNImageRequestHandler(cgImage: image, orientation: .up)
        try handler.perform([faceRequest, humanRequest, textRequest, classificationRequest])

        let faces = (faceRequest.results ?? []).map { observation in
            let bounds = topLeftRect(observation.boundingBox)
            return FaceResult(
                confidence: observation.confidence,
                bounds: bounds,
                topMargin: bounds.y
            )
        }
        let humans = (humanRequest.results ?? []).map { observation in
            HumanResult(
                confidence: observation.confidence,
                bounds: topLeftRect(observation.boundingBox)
            )
        }
        let textObservations: [VNRecognizedTextObservation] = textRequest.results ?? []
        let recognizedText: [TextResult] = textObservations.compactMap { observation in
            guard let candidate = observation.topCandidates(1).first else {
                return nil
            }
            return TextResult(
                text: candidate.string,
                confidence: candidate.confidence,
                bounds: topLeftRect(observation.boundingBox)
            )
        }
        let classifications: [ClassificationResult] = (classificationRequest.results ?? [])
            .filter { $0.confidence >= 0.12 }
            .prefix(8)
            .map { observation in
                ClassificationResult(
                    identifier: observation.identifier,
                    confidence: observation.confidence
                )
            }

        output.append(
            FrameResult(
                path: file,
                width: image.width,
                height: image.height,
                faces: faces,
                humans: humans,
                recognizedText: recognizedText,
                classifications: classifications,
                status: "pass",
                error: nil
            )
        )
    } catch {
        output.append(
            FrameResult(
                path: file,
                width: image.width,
                height: image.height,
                faces: [],
                humans: [],
                recognizedText: [],
                classifications: [],
                status: "fail",
                error: error.localizedDescription
            )
        )
    }
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
do {
    let data = try encoder.encode(output)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    FileHandle.standardError.write(Data("JSON encode failed: \(error)\n".utf8))
    exit(1)
}
