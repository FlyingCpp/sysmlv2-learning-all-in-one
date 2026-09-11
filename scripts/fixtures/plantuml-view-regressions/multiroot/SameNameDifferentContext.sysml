package SameNameDifferentContext {
part a { part sensor; } part b { part sensor; }
view target : StandardViewDefinitions::GeneralView { expose a; expose b; }
}
