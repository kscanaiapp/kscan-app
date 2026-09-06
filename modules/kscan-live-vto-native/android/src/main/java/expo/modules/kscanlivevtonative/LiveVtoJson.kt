package expo.modules.kscanlivevtonative

/**
 * A minimal, dependency-free JSON reader.
 *
 * Replaces `org.json` in the garment/BodyFrame loading path for one concrete
 * reason: `org.json` is an Android framework class, stubbed out in JVM unit
 * tests. Any manifest parsing that used it could only be exercised on a
 * device or emulator, which would make the cross-runtime conformance goldens
 * (amendment D8/D12) dependent on emulator health -- precisely the
 * dependency the mission tells this lane not to accept. With this reader,
 * manifest load + geometry compute run identically in a plain JVM test and
 * on the device, from the same source.
 *
 * Scope is deliberately narrow: it reads the well-formed, repo-committed
 * fixture and golden files this module owns. It is not a hardened parser for
 * untrusted input and is not used on any network or user-supplied data.
 */
object LiveVtoJson {

  fun parse(text: String): Any? {
    val parser = Parser(text)
    val value = parser.readValue()
    parser.skipWhitespace()
    if (!parser.atEnd) throw LiveVtoJsonException("trailing content at ${parser.pos}")
    return value
  }

  @Suppress("UNCHECKED_CAST")
  fun obj(v: Any?): Map<String, Any?> = v as? Map<String, Any?> ?: throw LiveVtoJsonException("expected object")

  @Suppress("UNCHECKED_CAST")
  fun arr(v: Any?): List<Any?> = v as? List<Any?> ?: throw LiveVtoJsonException("expected array")

  fun str(v: Any?): String = v as? String ?: throw LiveVtoJsonException("expected string, got $v")

  fun num(v: Any?): Double = v as? Double ?: throw LiveVtoJsonException("expected number, got $v")

  private class Parser(private val s: String) {
    var pos = 0
    val atEnd: Boolean get() = pos >= s.length

    fun skipWhitespace() {
      while (pos < s.length && s[pos].isWhitespace()) pos++
    }

    fun readValue(): Any? {
      skipWhitespace()
      if (atEnd) throw LiveVtoJsonException("unexpected end of input")
      return when (s[pos]) {
        '{' -> readObject()
        '[' -> readArray()
        '"' -> readString()
        't' -> readLiteral("true", true)
        'f' -> readLiteral("false", false)
        'n' -> readLiteral("null", null)
        else -> readNumber()
      }
    }

    private fun readLiteral(literal: String, value: Any?): Any? {
      if (!s.startsWith(literal, pos)) throw LiveVtoJsonException("bad literal at $pos")
      pos += literal.length
      return value
    }

    private fun readObject(): Map<String, Any?> {
      pos++
      val out = LinkedHashMap<String, Any?>()
      skipWhitespace()
      if (!atEnd && s[pos] == '}') {
        pos++
        return out
      }
      while (true) {
        skipWhitespace()
        val key = readString()
        skipWhitespace()
        if (atEnd || s[pos] != ':') throw LiveVtoJsonException("expected ':' at $pos")
        pos++
        out[key] = readValue()
        skipWhitespace()
        if (atEnd) throw LiveVtoJsonException("unterminated object")
        when (s[pos]) {
          ',' -> pos++
          '}' -> {
            pos++
            return out
          }
          else -> throw LiveVtoJsonException("expected ',' or '}' at $pos")
        }
      }
    }

    private fun readArray(): List<Any?> {
      pos++
      val out = ArrayList<Any?>()
      skipWhitespace()
      if (!atEnd && s[pos] == ']') {
        pos++
        return out
      }
      while (true) {
        out.add(readValue())
        skipWhitespace()
        if (atEnd) throw LiveVtoJsonException("unterminated array")
        when (s[pos]) {
          ',' -> pos++
          ']' -> {
            pos++
            return out
          }
          else -> throw LiveVtoJsonException("expected ',' or ']' at $pos")
        }
      }
    }

    private fun readString(): String {
      if (atEnd || s[pos] != '"') throw LiveVtoJsonException("expected string at $pos")
      pos++
      val b = StringBuilder()
      while (true) {
        if (atEnd) throw LiveVtoJsonException("unterminated string")
        val ch = s[pos++]
        if (ch == '"') return b.toString()
        if (ch != '\\') {
          b.append(ch)
          continue
        }
        if (atEnd) throw LiveVtoJsonException("unterminated escape")
        when (val esc = s[pos++]) {
          '"' -> b.append('"')
          '\\' -> b.append('\\')
          '/' -> b.append('/')
          'b' -> b.append('\b')
          'f' -> b.append(12.toChar())
          'n' -> b.append('\n')
          'r' -> b.append('\r')
          't' -> b.append('\t')
          'u' -> {
            if (pos + 4 > s.length) throw LiveVtoJsonException("truncated unicode escape at $pos")
            b.append(s.substring(pos, pos + 4).toInt(16).toChar())
            pos += 4
          }
          else -> throw LiveVtoJsonException("bad escape character '$esc' at $pos")
        }
      }
    }

    private fun readNumber(): Double {
      val start = pos
      if (!atEnd && (s[pos] == '-' || s[pos] == '+')) pos++
      while (!atEnd) {
        val c = s[pos]
        val partOfNumber = c.isDigit() || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-'
        if (!partOfNumber) break
        pos++
      }
      val slice = s.substring(start, pos)
      return slice.toDoubleOrNull() ?: throw LiveVtoJsonException("bad number '$slice' at $start")
    }
  }
}

class LiveVtoJsonException(message: String) : Exception(message)
