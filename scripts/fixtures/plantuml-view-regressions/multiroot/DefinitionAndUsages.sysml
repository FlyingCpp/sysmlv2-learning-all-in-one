package DefinitionAndUsages {
part def Unit { part child; } part u1 : Unit; part u2 : Unit;
view target : StandardViewDefinitions::GeneralView { expose Unit; expose u1; expose u2; }
}
