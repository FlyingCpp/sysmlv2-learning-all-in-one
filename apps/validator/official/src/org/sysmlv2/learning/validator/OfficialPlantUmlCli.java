package org.sysmlv2.learning.validator;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.eclipse.xtext.validation.Issue;
import org.omg.sysml.interactive.SysMLInteractive;
import org.omg.sysml.interactive.SysMLInteractiveResult;
import org.omg.sysml.interactive.VizResult;
import org.omg.sysml.lang.sysml.Element;
import org.omg.sysml.lang.sysml.RenderingUsage;
import org.omg.sysml.lang.sysml.Type;
import org.omg.sysml.lang.sysml.ViewUsage;
import org.omg.sysml.util.TypeUtil;

public final class OfficialPlantUmlCli {
    private static final String SOURCE = "official-sysml-v2-pilot-2026-04";
    private static final List<ViewModeSpec> STANDARD_VIEW_MODES = List.of(
        new ViewModeSpec("StandardViewDefinitions::SequenceView", "SEQUENCE"),
        new ViewModeSpec("StandardViewDefinitions::StateTransitionView", "STATE"),
        new ViewModeSpec("StandardViewDefinitions::ActionFlowView", "ACTION"),
        new ViewModeSpec("StandardViewDefinitions::InterconnectionView", "INTERCONNECTION"),
        new ViewModeSpec("StandardViewDefinitions::GeneralView", "DEFAULT")
    );

    private final SysMLInteractive interactive;
    private final PrintStream jsonOut;

    private OfficialPlantUmlCli(String libraryPath, String dotPath, PrintStream jsonOut) {
        this.jsonOut = jsonOut;
        this.interactive = SysMLInteractive.createInstance();
        this.interactive.loadLibrary(libraryPath);
        if (dotPath != null && !dotPath.isBlank()) {
            this.interactive.setGraphVizPath(dotPath);
        }
    }

    public static void main(String[] args) throws Exception {
        String libraryPath = readArg(args, "--library");
        if (libraryPath == null || libraryPath.isBlank()) {
            throw new IllegalArgumentException("--library is required");
        }
        String dotPath = readArg(args, "--dot");

        PrintStream originalOut = System.out;
        System.setOut(new PrintStream(OutputStream.nullOutputStream(), true, StandardCharsets.UTF_8));

        OfficialPlantUmlCli cli = new OfficialPlantUmlCli(libraryPath, dotPath, originalOut);
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
                String[] parts = line.split("\\t", -1);
                String source = decodePart(parts, 0);
                String viewName = decodePart(parts, 1);
                String renderMode = decodePart(parts, 2);
                List<String> styles = csvList(decodePart(parts, 3));
                response = render(source, viewName, renderMode, styles);
            } catch (Exception error) {
                response = errorResult(error);
            }
            jsonOut.println(response);
            jsonOut.flush();
        }
    }

    private String render(String source, String requestedViewName, String renderMode, List<String> styles) {
        SysMLInteractiveResult parsed = interactive.process(source, true);
        try {
            if (parsed.getException() != null) {
                return errorResult(parsed.getException());
            }
            if (parsed.hasErrors()) {
                return invalidResult(parsed.getIssues());
            }

            Selection selection = select(parsed.getRootElement(), requestedViewName, firstPackageName(source));
            RenderDecision renderDecision = resolveRenderDecision(selection.viewUsage, renderMode);
            List<String> renders = new ArrayList<>(List.of(renderDecision.mode));
            List<String> safeStyles = styles == null || styles.isEmpty() ? List.of("LR", "ORTHOLINE") : styles;

            VizResult viz;
            if (selection.viewName != null && !selection.viewName.isBlank()) {
                viz = interactive.view(selection.viewName, renders, new ArrayList<>(safeStyles), Collections.emptyList());
            } else if (!selection.elementNames.isEmpty()) {
                viz = interactive.viz(selection.elementNames, renders, new ArrayList<>(safeStyles), Collections.emptyList());
            } else {
                viz = VizResult.emptyResult();
            }

            if (viz.hasException()) {
                return errorResult(new RuntimeException(viz.formatException()));
            }
            StringBuilder out = new StringBuilder();
            out.append("{");
            field(out, "source", SOURCE).append(",");
            out.append("\"ok\":").append(viz.kind == VizResult.Kind.SVG || viz.kind == VizResult.Kind.EMPTY).append(",");
            field(out, "kind", viz.kind.name()).append(",");
            field(out, "viewName", selection.viewName).append(",");
            field(out, "renderMode", renderDecision.mode).append(",");
            field(out, "requestedRenderMode", normalizeRenderMode(renderMode)).append(",");
            field(out, "resolvedRenderMode", renderDecision.mode).append(",");
            field(out, "renderModeSource", renderDecision.source).append(",");
            field(out, "standardViewDefinition", renderDecision.standardViewDefinition).append(",");
            out.append("\"styles\":[");
            for (int i = 0; i < safeStyles.size(); i += 1) {
                if (i > 0) out.append(",");
                stringValue(out, safeStyles.get(i));
            }
            out.append("],");
            field(out, "svg", viz.getSVG()).append(",");
            field(out, "plantuml", viz.getPlantUML()).append(",");
            field(out, "text", viz.getText()).append(",");
            out.append("\"diagnostics\":[]");
            out.append("}");
            return out.toString();
        } finally {
            interactive.removeResource();
        }
    }

    private RenderDecision resolveRenderDecision(ViewUsage view, String requestedRenderMode) {
        if (view != null) {
            RenderingUsage rendering = view.getViewRendering();
            if (rendering != null) {
                String renderingName = rendering.getName();
                if ("asTreeDiagram".equals(renderingName)) {
                    return new RenderDecision("TREE", "model-rendering", null);
                }
                if ("asInterconnectionDiagram".equals(renderingName)) {
                    return new RenderDecision("INTERCONNECTION", "model-rendering", null);
                }
            }
        }

        String requested = normalizeRenderMode(requestedRenderMode);
        if (!requested.isBlank()) {
            return new RenderDecision(requested, "request", null);
        }

        if (view != null) {
            for (ViewModeSpec spec : STANDARD_VIEW_MODES) {
                Element resolved = interactive.resolve(spec.qualifiedName);
                if (!(resolved instanceof Type standardViewDefinition)) {
                    continue;
                }
                boolean matches = view.getType().stream()
                    .anyMatch(type -> TypeUtil.specializes(type, standardViewDefinition));
                if (matches) {
                    return new RenderDecision(spec.mode, "standard-view-definition", spec.qualifiedName);
                }
            }
        }

        return new RenderDecision("DEFAULT", "default", null);
    }

    private static String normalizeRenderMode(String renderMode) {
        return renderMode == null || renderMode.isBlank() ? "" : renderMode.trim().toUpperCase();
    }

    private Selection select(Element root, String requestedViewName, String preferredPackageName) {
        List<ViewUsage> views = new ArrayList<>();
        collectViews(root, views);

        if (requestedViewName != null && !requestedViewName.isBlank()) {
            String requested = requestedViewName.trim();
            if (requested.contains("::")) {
                for (ViewUsage view : views) {
                    String qualified = elementName(view);
                    if (requested.equals(qualified)) {
                        return new Selection(view, requested, Collections.emptyList());
                    }
                }
                String shortName = requested.substring(requested.lastIndexOf("::") + 2);
                Selection fallback = select(root, shortName, preferredPackageName);
                if (fallback.viewName != null && !fallback.viewName.isBlank()) {
                    return fallback;
                }
                return new Selection(null, requested, Collections.emptyList());
            }
            List<ViewUsage> matches = new ArrayList<>();
            for (ViewUsage view : views) {
                String qualified = elementName(view);
                String name = view.getName() == null ? "" : view.getName();
                String declaredName = view.getDeclaredName() == null ? "" : view.getDeclaredName();
                if (requested.equals(name) || requested.equals(declaredName) || (qualified != null && qualified.endsWith("::" + requested))) {
                    matches.add(view);
                }
            }
            matches.sort((left, right) -> Integer.compare(viewRank(right, preferredPackageName), viewRank(left, preferredPackageName)));
            if (!matches.isEmpty()) {
                ViewUsage selected = matches.get(0);
                return new Selection(selected, elementName(selected), Collections.emptyList());
            }
            return new Selection(null, requested, Collections.emptyList());
        }

        views.sort((left, right) -> Integer.compare(viewRank(right, preferredPackageName), viewRank(left, preferredPackageName)));
        for (ViewUsage view : views) {
            String name = elementName(view);
            if (name != null && !name.isBlank()) {
                return new Selection(view, name, Collections.emptyList());
            }
        }

        String rootName = elementName(root);
        if (rootName != null && !rootName.isBlank()) {
            return new Selection(null, null, List.of(rootName));
        }
        return new Selection(null, null, Collections.emptyList());
    }

    private static int viewRank(ViewUsage view, String preferredPackageName) {
        int score = viewScore(view);
        String qualified = elementName(view);
        if (preferredPackageName != null && !preferredPackageName.isBlank() && qualified != null && qualified.startsWith(preferredPackageName + "::")) {
            score += 1000;
        }
        return score;
    }

    private static int viewScore(ViewUsage view) {
        int score = view.getExposedElement().isEmpty() ? 0 : 20;
        String name = String.valueOf(view.getName()).toLowerCase();
        if (name.contains("browser")) score += 60;
        if (name.contains("tree")) score += 50;
        if (name.contains("overview")) score += 20;
        RenderingUsage rendering = view.getViewRendering();
        if (rendering != null) {
            String renderingName = String.valueOf(rendering.getName());
            if ("asTreeDiagram".equals(renderingName)) score += 50;
            if ("asInterconnectionDiagram".equals(renderingName)) score += 40;
        }
        return score;
    }

    private static void collectViews(Element element, List<ViewUsage> out) {
        if (element == null) return;
        if (element instanceof ViewUsage view) out.add(view);
        for (Element owned : element.getOwnedElement()) {
            collectViews(owned, out);
        }
    }

    private static String elementName(Element element) {
        if (element == null) return null;
        if (element.getQualifiedName() != null && !element.getQualifiedName().isBlank()) return element.getQualifiedName();
        if (element.getName() != null && !element.getName().isBlank()) return element.getName();
        if (element.getDeclaredName() != null && !element.getDeclaredName().isBlank()) return element.getDeclaredName();
        return element.eClass().getName();
    }

    private static String firstPackageName(String source) {
        Matcher matcher = Pattern.compile("(?m)\\bpackage\\s+([A-Za-z_][\\w]*)\\s*\\{").matcher(String.valueOf(source));
        return matcher.find() ? matcher.group(1) : "";
    }

    private static String invalidResult(List<Issue> issues) {
        StringBuilder out = new StringBuilder();
        out.append("{");
        field(out, "source", SOURCE).append(",");
        out.append("\"ok\":false,");
        field(out, "kind", "ERROR").append(",");
        field(out, "svg", null).append(",");
        out.append("\"diagnostics\":[");
        for (int i = 0; i < issues.size(); i += 1) {
            if (i > 0) out.append(",");
            issue(out, issues.get(i));
        }
        out.append("]}");
        return out.toString();
    }

    private static void issue(StringBuilder out, Issue issue) {
        out.append("{");
        field(out, "file", issue.getUriToProblem() == null ? "main.sysml" : issue.getUriToProblem().toString()).append(",");
        numberField(out, "line", issue.getLineNumber()).append(",");
        numberField(out, "column", issue.getColumn()).append(",");
        field(out, "severity", issue.getSeverity() == null ? "error" : issue.getSeverity().toString().toLowerCase()).append(",");
        field(out, "category", issue.isSyntaxError() ? "syntax" : "semantic").append(",");
        field(out, "message", issue.getMessage()).append(",");
        field(out, "source", SOURCE);
        out.append("}");
    }

    private static String errorResult(Throwable error) {
        StringBuilder out = new StringBuilder();
        out.append("{");
        field(out, "source", SOURCE).append(",");
        out.append("\"ok\":false,");
        field(out, "kind", "ERROR").append(",");
        field(out, "svg", null).append(",");
        out.append("\"diagnostics\":[{");
        field(out, "file", "main.sysml").append(",");
        out.append("\"line\":1,");
        out.append("\"column\":1,");
        field(out, "severity", "error").append(",");
        field(out, "category", "plantuml").append(",");
        field(out, "message", error.getClass().getSimpleName() + ": " + safeMessage(error)).append(",");
        field(out, "source", SOURCE);
        out.append("}]}");
        return out.toString();
    }

    private static String decodePart(String[] parts, int index) {
        if (index >= parts.length || parts[index] == null || parts[index].isBlank()) return "";
        return new String(Base64.getDecoder().decode(parts[index].trim()), StandardCharsets.UTF_8);
    }

    private static List<String> csvList(String value) {
        List<String> out = new ArrayList<>();
        for (String item : String.valueOf(value).split(",")) {
            String trimmed = item.trim();
            if (!trimmed.isEmpty()) out.add(trimmed);
        }
        return out;
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
                    if (ch < 0x20) out.append(String.format("\\u%04x", (int) ch));
                    else out.append(ch);
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
            if (name.equals(args[i])) return args[i + 1];
        }
        return null;
    }

    private record Selection(ViewUsage viewUsage, String viewName, List<String> elementNames) {
    }

    private record RenderDecision(String mode, String source, String standardViewDefinition) {
    }

    private record ViewModeSpec(String qualifiedName, String mode) {
    }
}
