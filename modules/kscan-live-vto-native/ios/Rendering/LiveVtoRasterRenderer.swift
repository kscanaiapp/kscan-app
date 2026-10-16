#if canImport(CoreGraphics)
import CoreGraphics

/// The production Core Graphics mesh rasterizer, shared with host pixel tests.
public enum LiveVtoRasterRenderer {
  public static func drawMesh(_ context: CGContext, image: CGImage, meshCellsWide: Int, meshCellsHigh: Int, verts: [Float], textureWidth: Int, textureHeight: Int) {
    guard meshCellsWide > 0, meshCellsHigh > 0, textureWidth > 0, textureHeight > 0 else { return }
    guard verts.count == (meshCellsWide + 1) * (meshCellsHigh + 1) * 2, verts.allSatisfy({ $0.isFinite }) else { return }
    let vertsPerRow = meshCellsWide + 1
    func destAt(_ col: Int, _ row: Int) -> CGPoint {
      let i = (row * vertsPerRow + col) * 2
      return CGPoint(x: CGFloat(verts[i]), y: CGFloat(verts[i + 1]))
    }
    func sourceAt(_ col: Int, _ row: Int) -> CGPoint {
      CGPoint(x: CGFloat(col) / CGFloat(meshCellsWide) * CGFloat(textureWidth),
              y: CGFloat(row) / CGFloat(meshCellsHigh) * CGFloat(textureHeight))
    }
    for row in 0..<meshCellsHigh {
      for col in 0..<meshCellsWide {
        let d00 = destAt(col, row), d10 = destAt(col + 1, row), d01 = destAt(col, row + 1), d11 = destAt(col + 1, row + 1)
        let s00 = sourceAt(col, row), s10 = sourceAt(col + 1, row), s01 = sourceAt(col, row + 1), s11 = sourceAt(col + 1, row + 1)
        drawTriangle(context, image: image, src: (s00, s10, s01), dst: (d00, d10, d01))
        drawTriangle(context, image: image, src: (s10, s11, s01), dst: (d10, d11, d01))
      }
    }
  }

  private static func drawTriangle(_ context: CGContext, image: CGImage, src: (CGPoint, CGPoint, CGPoint), dst: (CGPoint, CGPoint, CGPoint)) {
    // Solve the affine transform T with T(src.0)=dst.0, T(src.1)=dst.1, T(src.2)=dst.2.
    // Edge vectors: M_src * A = M_dst  =>  A = M_dst * M_src^-1 (2x2), then translation from src.0/dst.0.
    let sx1 = Double(src.1.x - src.0.x), sy1 = Double(src.1.y - src.0.y)
    let sx2 = Double(src.2.x - src.0.x), sy2 = Double(src.2.y - src.0.y)
    let dx1 = Double(dst.1.x - dst.0.x), dy1 = Double(dst.1.y - dst.0.y)
    let dx2 = Double(dst.2.x - dst.0.x), dy2 = Double(dst.2.y - dst.0.y)

    let det = sx1 * sy2 - sy1 * sx2
    guard abs(det) > 1e-9 else { return } // degenerate triangle -- nothing to draw

    let invDet = 1.0 / det
    // M_src^-1
    let ia = sy2 * invDet, ib = -sy1 * invDet
    let ic = -sx2 * invDet, id = sx1 * invDet

    // A = [dx1 dx2; dy1 dy2] * [ia ib; ic id]
    let a = dx1 * ia + dx2 * ib
    let b = dy1 * ia + dy2 * ib
    let c = dx1 * ic + dx2 * id
    let d = dy1 * ic + dy2 * id
    // translation: dst.0 = A*src.0 + t  =>  t = dst.0 - A*src.0
    let tx = Double(dst.0.x) - (a * Double(src.0.x) + c * Double(src.0.y))
    let ty = Double(dst.0.y) - (b * Double(src.0.x) + d * Double(src.0.y))

    let transform = CGAffineTransform(a: CGFloat(a), b: CGFloat(b), c: CGFloat(c), d: CGFloat(d), tx: CGFloat(tx), ty: CGFloat(ty))

    context.saveGState()
    let path = CGMutablePath()
    path.move(to: dst.0)
    path.addLine(to: dst.1)
    path.addLine(to: dst.2)
    path.closeSubpath()
    context.addPath(path)
    context.clip()
    context.concatenate(transform)
    // Now in texture-space coordinates (post-concat): clip additionally to
    // the alpha mask's own coverage (already baked into `image` by
    // `combineTextureAndAlpha`, so this draw call alone carries both the
    // garment silhouette and its texture).
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    context.restoreGState()
  }

}
#endif
