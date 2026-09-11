package RelationRegression {
    port def SignalPort { out value : ScalarValues::Real; }
    part def Device {
        port output : SignalPort;
        port input : ~SignalPort;
    }
    part system {
        part left : Device {
            perform action compute {
                in received : ScalarValues::Real = input.value;
                out sent : ScalarValues::Real = output.value;
            }
        }
        part right : Device {
            perform action compute {
                in received : ScalarValues::Real = input.value;
                out sent : ScalarValues::Real = output.value;
            }
        }
        connection wire connect left.output to right.input;
        bind left.output.value = right.input.value;
        binding secondBinding bind left.output.value = right.input.value;
        connect left to right;
        attribute constantValue : ScalarValues::Real = 2.0;
        attribute initialValue : ScalarValues::Real := constantValue;
        attribute defaultValue : ScalarValues::Real default = constantValue;
        attribute fixedValue : ScalarValues::Real = constantValue;
        attribute computedValue : ScalarValues::Real = constantValue + 1;
    }
    view overview : StandardViewDefinitions::InterconnectionView { expose system; }
    part portValues {
        port sourcePort : SignalPort;
        port boundPort : SignalPort = sourcePort;
    }
    view portOverview : StandardViewDefinitions::InterconnectionView { expose portValues; }
}
