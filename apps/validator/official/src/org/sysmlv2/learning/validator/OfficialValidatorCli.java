package org.sysmlv2.learning.validator;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;

import org.eclipse.xtext.validation.Issue;
import org.omg.sysml.interactive.SysMLInteractive;
import org.omg.sysml.interactive.SysMLInteractiveResult;

public final class OfficialValidatorCli {
    private static final String SOURCE = "official-sysml-v2-pilot-2026-04";

    private final SysMLInteractive interactive;
    private final PrintStream jsonOut;

    private OfficialValidatorCli(String libraryPath, PrintStream jsonOut) {
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

        OfficialValidatorCli cli = new OfficialValidatorCli(libraryPath, originalOut);
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
                response = validate(source);
            } catch (Exception error) {
                response = errorResult(error);
            }
            jsonOut.println(response);
            jsonOut.flush();
        }
    }

    private String validate(String source) {
        SysMLInteractiveResult result = interactive.process(source, false);
        try {
            if (result.getException() != null) {
                return errorResult(result.getException());
            }
            List<Issue> issues = result.getIssues();
            boolean syntaxValid = result.getSyntaxErrors().isEmpty();
            boolean semanticValid = result.getSemanticErrors().isEmpty();
            StringBuilder out = new StringBuilder();
            out.append("{");
            field(out, "source", SOURCE).append(",");
            out.append("\"syntaxValid\":").append(syntaxValid).append(",");
            out.append("\"semanticValid\":").append(semanticValid).append(",");
            out.append("\"valid\":").append(syntaxValid && semanticValid).append(",");
            out.append("\"validationCompleteness\":\"official\",");
            out.append("\"diagnostics\":[");
            for (int i = 0; i < issues.size(); i += 1) {
                if (i > 0) {
                    out.append(",");
                }
                issue(out, issues.get(i));
            }
            out.append("]}");
            return out.toString();
        } finally {
            interactive.removeResource();
        }
    }

    private static void issue(StringBuilder out, Issue issue) {
        out.append("{");
        field(out, "file", issue.getUriToProblem() == null ? "main.sysml" : issue.getUriToProblem().toString()).append(",");
        numberField(out, "line", issue.getLineNumber()).append(",");
        numberField(out, "column", issue.getColumn()).append(",");
        field(out, "severity", issue.getSeverity() == null ? "error" : issue.getSeverity().toString().toLowerCase()).append(",");
        field(out, "category", issue.isSyntaxError() ? "syntax" : "semantic").append(",");
        field(out, "message", issue.getMessage()).append(",");
        field(out, "code", issue.getCode()).append(",");
        field(out, "source", SOURCE);
        out.append("}");
    }

    private static String errorResult(Throwable error) {
        StringBuilder out = new StringBuilder();
        out.append("{");
        field(out, "source", SOURCE).append(",");
        out.append("\"syntaxValid\":false,");
        out.append("\"semanticValid\":false,");
        out.append("\"valid\":false,");
        out.append("\"validationCompleteness\":\"official\",");
        out.append("\"diagnostics\":[{");
        field(out, "file", "main.sysml").append(",");
        out.append("\"line\":1,");
        out.append("\"column\":1,");
        field(out, "severity", "error").append(",");
        field(out, "category", "internal").append(",");
        field(out, "message", error.getClass().getSimpleName() + ": " + safeMessage(error)).append(",");
        field(out, "source", SOURCE);
        out.append("}]}");
        return out.toString();
    }

    private static StringBuilder field(StringBuilder out, String key, String value) {
        out.append("\"").append(escape(key)).append("\":");
        if (value == null) {
            out.append("null");
        } else {
            out.append("\"").append(escape(value)).append("\"");
        }
        return out;
    }

    private static StringBuilder numberField(StringBuilder out, String key, Integer value) {
        out.append("\"").append(escape(key)).append("\":").append(value == null ? 1 : value);
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
