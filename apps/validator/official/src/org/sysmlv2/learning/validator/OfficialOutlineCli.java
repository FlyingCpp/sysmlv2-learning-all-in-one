package org.sysmlv2.learning.validator;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import org.eclipse.xtext.validation.Issue;
import org.omg.sysml.interactive.SysMLInteractive;
import org.omg.sysml.interactive.SysMLInteractiveResult;
import org.omg.sysml.lang.sysml.Element;
import org.omg.sysml.lang.sysml.Relationship;

public final class OfficialOutlineCli {
    private static final String SOURCE = "official-sysml-v2-pilot-2026-04";

    private final SysMLInteractive interactive;
    private final PrintStream jsonOut;

    private OfficialOutlineCli(String libraryPath, PrintStream jsonOut) {
        this.jsonOut = jsonOut;
        this.interactive = SysMLInteractive.createInstance();
        this.interactive.loadLibrary(libraryPath);
    }

    public static void main(String[] args) throws Exception {
        String libraryPath = readArg(args, "--library");
        if (libraryPath == null || libraryPath.isBlank()) {
            throw new IllegalArgumentException("--library is required");
        }

        PrintStream originalOut = System.out;
        System.setOut(new PrintStream(OutputStream.nullOutputStream(), true, StandardCharsets.UTF_8));

        OfficialOutlineCli cli = new OfficialOutlineCli(libraryPath, originalOut);
        cli.run();
    }

    private void run() throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = reader.readLine()) != null) {
            if (line.isBlank()) {
                continue;
            }
            String response;
            try {
                String source = new String(Base64.getDecoder().decode(line.trim()), StandardCharsets.UTF_8);
                response = outline(source);
            } catch (Exception error) {
                response = unavailableResult("", error);
            }
            jsonOut.println(response);
            jsonOut.flush();
        }
    }

    private String outline(String source) {
        SysMLInteractiveResult parsed = interactive.process(source, true);
        try {
            if (parsed.getException() != null) {
                return unavailableResult(source, parsed.getException());
            }
            if (parsed.hasErrors() || parsed.getRootElement() == null) {
                return invalidResult(source, parsed.getIssues());
            }

            StringBuilder out = new StringBuilder();
            out.append("{");
            field(out, "source", SOURCE).append(",");
            field(out, "status", "available").append(",");
            field(out, "generatedAt", Instant.now().toString()).append(",");
            field(out, "contentHash", contentHash(source)).append(",");
            out.append("\"roots\":[");
            node(out, parsed.getRootElement(), null, new AtomicInteger(1));
            out.append("]}");
            return out.toString();
        } finally {
            interactive.removeResource();
        }
    }

    private static void node(StringBuilder out, Element element, String parentId, AtomicInteger counter) {
        String id = "official-outline-" + counter.getAndIncrement();
        String metaclass = metaclass(element);
        out.append("{");
        field(out, "id", id).append(",");
        field(out, "parentId", parentId).append(",");
        field(out, "name", elementName(element)).append(",");
        field(out, "declaredName", element.getDeclaredName()).append(",");
        field(out, "qualifiedName", element.getQualifiedName()).append(",");
        field(out, "metaclass", metaclass).append(",");
        field(out, "displayKind", displayKind(metaclass)).append(",");
        field(out, "file", null).append(",");
        nullableNumberField(out, "line", null).append(",");
        nullableNumberField(out, "column", null).append(",");
        out.append("\"isImplicit\":").append(isImplicit(element, metaclass)).append(",");
        out.append("\"isLibrary\":").append(element.isLibraryElement()).append(",");
        out.append("\"children\":[");
        List<Element> children = outlineChildren(element);
        for (int i = 0; i < children.size(); i += 1) {
            if (i > 0) {
                out.append(",");
            }
            node(out, children.get(i), id, counter);
        }
        out.append("]}");
    }

    private static List<Element> outlineChildren(Element element) {
        List<Element> children = new ArrayList<>();
        if (element instanceof Relationship relationship) {
            children.addAll(relationship.getOwnedRelatedElement());
            if (!children.isEmpty()) {
                return children;
            }
        }
        children.addAll(element.getOwnedRelationship());
        if (!children.isEmpty()) {
            return children;
        }
        children.addAll(element.getOwnedElement());
        return children;
    }

    private static String invalidResult(String source, List<Issue> issues) {
        StringBuilder out = new StringBuilder();
        out.append("{");
        field(out, "source", SOURCE).append(",");
        field(out, "status", "invalid").append(",");
        field(out, "generatedAt", Instant.now().toString()).append(",");
        field(out, "contentHash", contentHash(source)).append(",");
        out.append("\"roots\":[],");
        out.append("\"diagnostics\":[");
        for (int i = 0; i < issues.size(); i += 1) {
            if (i > 0) {
                out.append(",");
            }
            issue(out, issues.get(i));
        }
        out.append("]}");
        return out.toString();
    }

    private static String unavailableResult(String source, Throwable error) {
        StringBuilder out = new StringBuilder();
        out.append("{");
        field(out, "source", SOURCE).append(",");
        field(out, "status", "unavailable").append(",");
        field(out, "generatedAt", Instant.now().toString()).append(",");
        field(out, "contentHash", contentHash(source)).append(",");
        out.append("\"roots\":[],");
        out.append("\"diagnostics\":[{");
        field(out, "file", "main.sysml").append(",");
        nullableNumberField(out, "line", 1).append(",");
        nullableNumberField(out, "column", 1).append(",");
        field(out, "severity", "error").append(",");
        field(out, "category", "infrastructure").append(",");
        field(out, "message", error.getClass().getSimpleName() + ": " + safeMessage(error)).append(",");
        field(out, "source", SOURCE);
        out.append("}]}");
        return out.toString();
    }

    private static void issue(StringBuilder out, Issue issue) {
        out.append("{");
        field(out, "file", issue.getUriToProblem() == null ? "main.sysml" : issue.getUriToProblem().toString()).append(",");
        nullableNumberField(out, "line", issue.getLineNumber()).append(",");
        nullableNumberField(out, "column", issue.getColumn()).append(",");
        field(out, "severity", issue.getSeverity() == null ? "error" : issue.getSeverity().toString().toLowerCase()).append(",");
        field(out, "category", issue.isSyntaxError() ? "syntax" : "semantic").append(",");
        field(out, "message", issue.getMessage()).append(",");
        field(out, "code", issue.getCode()).append(",");
        field(out, "source", SOURCE);
        out.append("}");
    }

    private static String elementName(Element element) {
        if (element == null) {
            return "";
        }
        String explicit = explicitElementName(element);
        if (explicit != null && !explicit.isBlank()) {
            return explicit;
        }
        if (element instanceof Relationship relationship) {
            String targetNames = relatedNames(relationship.getTarget());
            if (targetNames != null && !targetNames.isBlank()) {
                return metaclass(element) + " " + targetNames;
            }
            String relatedNames = relatedNames(relationship.getRelatedElement());
            if (relatedNames != null && !relatedNames.isBlank()) {
                return metaclass(element) + " " + relatedNames;
            }
        }
        return metaclass(element);
    }

    private static String explicitElementName(Element element) {
        if (element.getDeclaredName() != null && !element.getDeclaredName().isBlank()) {
            return element.getDeclaredName();
        }
        if (element.getName() != null && !element.getName().isBlank()) {
            return element.getName();
        }
        if (element.getQualifiedName() != null && !element.getQualifiedName().isBlank()) {
            String qualifiedName = element.getQualifiedName();
            int index = qualifiedName.lastIndexOf("::");
            return index >= 0 ? qualifiedName.substring(index + 2) : qualifiedName;
        }
        return null;
    }

    private static String relatedNames(List<Element> elements) {
        List<String> names = new ArrayList<>();
        for (Element element : elements) {
            String name = explicitElementName(element);
            if (name != null && !name.isBlank()) {
                names.add(name);
            }
        }
        return String.join(", ", names);
    }

    private static String metaclass(Element element) {
        return element == null || element.eClass() == null ? "Element" : element.eClass().getName();
    }

    private static String displayKind(String metaclass) {
        return metaclass == null || metaclass.isBlank() ? "Element" : metaclass;
    }

    private static boolean isImplicit(Element element, String metaclass) {
        String text = (String.valueOf(metaclass) + " " + String.valueOf(elementName(element))).toLowerCase();
        return element.isImpliedIncluded() || text.contains("implicit") || (element instanceof Relationship relationship && relationship.isImplied());
    }

    private static String contentHash(String source) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return "sha256:" + HexFormat.of().formatHex(digest.digest(String.valueOf(source).getBytes(StandardCharsets.UTF_8)));
        } catch (Exception error) {
            return "sha256:unavailable";
        }
    }

    private static StringBuilder field(StringBuilder out, String key, String value) {
        out.append("\"").append(escape(key)).append("\":");
        if (value == null) {
            out.append("null");
        } else {
            stringValue(out, value);
        }
        return out;
    }

    private static void stringValue(StringBuilder out, String value) {
        out.append("\"").append(escape(value)).append("\"");
    }

    private static StringBuilder nullableNumberField(StringBuilder out, String key, Integer value) {
        out.append("\"").append(escape(key)).append("\":").append(value == null ? "null" : value);
        return out;
    }

    private static String escape(String value) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < value.length(); i += 1) {
            char ch = value.charAt(i);
            switch (ch) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (ch < 0x20) {
                        out.append(String.format("\\u%04x", (int) ch));
                    } else {
                        out.append(ch);
                    }
                }
            }
        }
        return out.toString();
    }

    private static String safeMessage(Throwable error) {
        return error.getMessage() == null ? "no message" : error.getMessage();
    }

    private static String readArg(String[] args, String name) {
        for (int i = 0; i < args.length - 1; i += 1) {
            if (name.equals(args[i])) {
                return args[i + 1];
            }
        }
        return null;
    }
}
