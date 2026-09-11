package MixedRequirements {
part def Drone; part drone : Drone; requirement endurance { subject aircraft : Drone; } satisfy endurance by drone;
view target : StandardViewDefinitions::GeneralView { expose Drone; expose drone; expose endurance; }
}
