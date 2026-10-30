import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 88.75 / 55;
  return (
    <Svg
      accessibilityLabel="E4"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="20 36.5 88.75 55"
    >
      <ThemedPath
        d="M20 36.5h12.5v55h-12.5zM20 36.5h37.5v12.5h-37.5zM20 57.75h32.5v12.5h-32.5zM20 79h37.5v12.5h-37.5zM86.25 36.5h12.5v55h-12.5zM65 67.5h43.75v12.5h-43.75zM84.25 36.5L98.75 36.5L79.5 67.5L65 67.5z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
