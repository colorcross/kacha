#!/usr/bin/env swift

import AppKit
import AVFoundation
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import Vision

struct FaceRecord: Codable {
    let confidence: Float
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct FrameRecord: Codable {
    let index: Int
    let timeSeconds: Double
    let personMask: String?
    let faceMask: String?
    let faces: [FaceRecord]
}

struct Manifest: Codable {
    let input: String
    let generatedAt: String
    let sampleFPS: Double
    let sourceFPS: Double
    let sourceDuration: Double
    let sourceWidth: Int
    let sourceHeight: Int
    let maskWidth: Int
    let maskHeight: Int
    let quality: String
    let frameCount: Int
    let frames: [FrameRecord]
    let limitations: [String]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

func usage() -> Never {
    fail("""
    Usage:
      generate_vision_masks.swift INPUT_VIDEO OUTPUT_DIR [sample_fps] [fast|balanced|accurate]

    Generates:
      person_000001.png ...  Person segmentation masks
      face_000001.png ...    Soft face-region masks
      manifest.json          Timing, dimensions and normalized face boxes

    For final rendering, use sample_fps equal to the source frame rate. Lower values
    are intended only for capability checks and effect planning.
    """)
}

guard CommandLine.arguments.count >= 3 else { usage() }

let inputPath = CommandLine.arguments[1]
let outputPath = CommandLine.arguments[2]
let sampleFPS = CommandLine.arguments.count >= 4 ? (Double(CommandLine.arguments[3]) ?? 5.0) : 5.0
let qualityName = CommandLine.arguments.count >= 5 ? CommandLine.arguments[4] : "balanced"

guard sampleFPS > 0 else { fail("sample_fps must be greater than zero") }
guard FileManager.default.fileExists(atPath: inputPath) else { fail("Input not found: \(inputPath)") }

let quality: VNGeneratePersonSegmentationRequest.QualityLevel
switch qualityName {
case "fast": quality = .fast
case "balanced": quality = .balanced
case "accurate": quality = .accurate
default: fail("quality must be fast, balanced or accurate")
}

let inputURL = URL(fileURLWithPath: inputPath)
let outputURL = URL(fileURLWithPath: outputPath, isDirectory: true)
if FileManager.default.fileExists(atPath: outputURL.path) {
    let existing = try FileManager.default.contentsOfDirectory(
        at: outputURL,
        includingPropertiesForKeys: nil
    )
    guard existing.isEmpty else {
        fail("Output directory must be empty to prevent stale mask frames: \(outputURL.path)")
    }
} else {
    try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)
}

let asset = AVURLAsset(url: inputURL)
guard let track = try await asset.loadTracks(withMediaType: .video).first else {
    fail("No video track found")
}

let transform = try await track.load(.preferredTransform)
let transformIsIdentity =
    abs(transform.a - 1.0) < 0.0001 &&
    abs(transform.b) < 0.0001 &&
    abs(transform.c) < 0.0001 &&
    abs(transform.d - 1.0) < 0.0001 &&
    abs(transform.tx) < 0.0001 &&
    abs(transform.ty) < 0.0001
guard transformIsIdentity else {
    fail("The source uses rotation, mirroring or translation metadata. Normalize it to an upright intermediate before mask generation.")
}

let naturalSize = try await track.load(.naturalSize)
let nominalFrameRate = try await track.load(.nominalFrameRate)
let durationTime = try await asset.load(.duration)
let sourceDuration = durationTime.seconds
let sourceWidth = Int(naturalSize.width.rounded())
let sourceHeight = Int(naturalSize.height.rounded())
let sourceFPS = nominalFrameRate > 0 ? Double(nominalFrameRate) : 25.0
guard sourceDuration.isFinite && sourceDuration > 0 else {
    fail("Could not determine a valid source duration")
}

guard let reader = try? AVAssetReader(asset: asset) else { fail("Could not create AVAssetReader") }
let output = AVAssetReaderTrackOutput(
    track: track,
    outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
    ]
)
output.alwaysCopiesSampleData = false
guard reader.canAdd(output) else { fail("Could not add video reader output") }
reader.add(output)
guard reader.startReading() else { fail("Could not start reading video") }

let personRequest = VNGeneratePersonSegmentationRequest()
personRequest.qualityLevel = quality
personRequest.outputPixelFormat = kCVPixelFormatType_OneComponent8

let faceRequest = VNDetectFaceRectanglesRequest()
let ciContext = CIContext(options: [.useSoftwareRenderer: false])
let interval = 1.0 / sampleFPS
var nextSampleTime = 0.0
var records: [FrameRecord] = []
var outputIndex = 0
var maskWidth = 0
var maskHeight = 0

func writePNG(from pixelBuffer: CVPixelBuffer, to url: URL) throws {
    let image = CIImage(cvPixelBuffer: pixelBuffer)
    guard let cgImage = ciContext.createCGImage(image, from: image.extent) else {
        throw NSError(domain: "KachaVision", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not create CGImage"])
    }
    let bitmap = NSBitmapImageRep(cgImage: cgImage)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "KachaVision", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not encode PNG"])
    }
    try data.write(to: url)
}

func writeFaceMask(width: Int, height: Int, faces: [VNFaceObservation], to url: URL) throws {
    let colorSpace = CGColorSpaceCreateDeviceGray()
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.none.rawValue
    ) else {
        throw NSError(domain: "KachaVision", code: 3, userInfo: [NSLocalizedDescriptionKey: "Could not create mask context"])
    }

    context.setFillColor(gray: 0, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.setFillColor(gray: 1, alpha: 1)

    for face in faces {
        let box = face.boundingBox
        let expandedX = max(0, box.minX - box.width * 0.10)
        let expandedY = max(0, box.minY - box.height * 0.10)
        let expandedW = min(1 - expandedX, box.width * 1.20)
        let expandedH = min(1 - expandedY, box.height * 1.22)
        let rect = CGRect(
            x: expandedX * Double(width),
            y: expandedY * Double(height),
            width: expandedW * Double(width),
            height: expandedH * Double(height)
        )
        context.fillEllipse(in: rect)
    }

    guard let cgImage = context.makeImage() else {
        throw NSError(domain: "KachaVision", code: 4, userInfo: [NSLocalizedDescriptionKey: "Could not create face mask image"])
    }
    let bitmap = NSBitmapImageRep(cgImage: cgImage)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "KachaVision", code: 5, userInfo: [NSLocalizedDescriptionKey: "Could not encode face mask PNG"])
    }
    try data.write(to: url)
}

while reader.status == .reading, let sampleBuffer = output.copyNextSampleBuffer() {
    let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
    if time + 0.0001 < nextSampleTime { continue }
    repeat {
        nextSampleTime += interval
    } while nextSampleTime <= time + 0.0001

    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { continue }
    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up, options: [:])

    do {
        try handler.perform([personRequest, faceRequest])
    } catch {
        FileHandle.standardError.write(Data(("Vision failed at \(time)s: \(error)\n").utf8))
        continue
    }

    outputIndex += 1
    let sequence = String(format: "%06d", outputIndex)
    var personName: String?
    var faceName: String?

    if let observation = personRequest.results?.first {
        let buffer = observation.pixelBuffer
        maskWidth = CVPixelBufferGetWidth(buffer)
        maskHeight = CVPixelBufferGetHeight(buffer)
        let name = "person_\(sequence).png"
        try writePNG(from: buffer, to: outputURL.appendingPathComponent(name))
        personName = name
    }

    let faces = faceRequest.results ?? []
    if maskWidth > 0 && maskHeight > 0 {
        let name = "face_\(sequence).png"
        try writeFaceMask(
            width: maskWidth,
            height: maskHeight,
            faces: faces,
            to: outputURL.appendingPathComponent(name)
        )
        faceName = name
    }

    let faceRecords = faces.map {
        FaceRecord(
            confidence: $0.confidence,
            x: $0.boundingBox.minX,
            y: $0.boundingBox.minY,
            width: $0.boundingBox.width,
            height: $0.boundingBox.height
        )
    }

    records.append(
        FrameRecord(
            index: outputIndex,
            timeSeconds: time,
            personMask: personName,
            faceMask: faceName,
            faces: faceRecords
        )
    )
}

guard !records.isEmpty else { fail("No masks were generated") }
guard reader.status == .completed else {
    fail("Video reader did not complete successfully: \(reader.error?.localizedDescription ?? "unknown error")")
}

let formatter = ISO8601DateFormatter()
let manifest = Manifest(
    input: inputURL.path,
    generatedAt: formatter.string(from: Date()),
    sampleFPS: sampleFPS,
    sourceFPS: sourceFPS,
    sourceDuration: sourceDuration,
    sourceWidth: sourceWidth,
    sourceHeight: sourceHeight,
    maskWidth: maskWidth,
    maskHeight: maskHeight,
    quality: qualityName,
    frameCount: records.count,
    frames: records,
    limitations: [
        "Face masks are soft elliptical regions, not semantic skin masks.",
        "Person and face masks require visual validation at occlusions, fast motion, glasses, hands near the face and edge frames.",
        "This tool rejects sources that rely on rotation metadata; normalize orientation first."
    ]
)

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
let manifestData = try encoder.encode(manifest)
try manifestData.write(
    to: outputURL.appendingPathComponent("manifest.json"),
    options: .atomic
)

print(outputURL.path)
