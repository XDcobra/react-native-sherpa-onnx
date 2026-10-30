import { Fragment } from 'react';
import { Text, View } from 'react-native';
import { styles } from './PipelineStepStrip.styles';

export type PipelineStepStripItem = {
  id: string;
  label: string;
  active: boolean;
};

export type PipelineStepStripProps = {
  steps: readonly PipelineStepStripItem[];
};

export function PipelineStepStrip({ steps }: PipelineStepStripProps) {
  return (
    <View style={styles.diagram}>
      {steps.map((step, i) => (
        <Fragment key={step.id}>
          {i > 0 ? (
            <Text style={[styles.arrow, step.active && styles.arrowActive]}>
              →
            </Text>
          ) : null}
          <View style={[styles.step, step.active && styles.stepActive]}>
            <Text
              style={[styles.stepLabel, step.active && styles.stepLabelActive]}
            >
              {step.label}
            </Text>
          </View>
        </Fragment>
      ))}
    </View>
  );
}
