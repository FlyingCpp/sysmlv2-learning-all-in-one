package EV_Analysis_Baseline {
  private import EV_Program_Baseline::*;
  private import EV_Requirement_Baseline::*;
  private import EV_Range_Calc_Baseline::*;

  analysis def RangeEvidenceAnalysis {
    subject vehicle : ElectricVehicle;
    in targetRangeKm : ScalarValues::Real;
    in reportedPredictionKm : ScalarValues::Real;

    objective rangeDecisionObjective {
      require constraint {
        reportedPredictionKm >= targetRangeKm
      }
    }

    calc estimateRange : EstimateRange {
      in usableEnergyKWh = vehicle.battery.usableEnergyKWh;
      in energyPer100Km = vehicle.energyPer100Km;
      return rawRangeKm;
    }

    return predictedRangeKm : ScalarValues::Real = reportedPredictionKm;
  }

  analysis cityRangePrediction : RangeEvidenceAnalysis {
    subject vehicle = evPrototype;
    in targetRangeKm = vehicleRange.minRangeKm;
    in reportedPredictionKm = evPrototype.reportedPredictionKm;
  }

  view def AnalysisBaselineView specializes StandardViewDefinitions::GeneralView;
  view analysisBaselineView : AnalysisBaselineView {
    expose vehicleRange;
    expose EstimateRange;
    expose cityRangePrediction;
    expose evPrototype;
  }
}
