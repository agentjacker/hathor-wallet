import React from 'react';


class PinInput extends React.Component {
  render() {
    return (
      <div>
        <label htmlFor="pin">Pin*</label>
        <small> (6 digits password)</small>
        <input type="password" ref="pin" pattern="[0-9]{6}" autoComplete="off" inputMode="numeric" className="pin-input form-control" required onChange={this.props.handleChangePin} />
      </div>
    )
  }
}

export default PinInput;
